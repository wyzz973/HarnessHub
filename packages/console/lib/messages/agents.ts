// SPDX-License-Identifier: MIT
/**
 * Messages of the agents area: the home page, an agent's detail, the
 * wiring plan, the model picker, profiles and the first run (see
 * ./types.ts).
 */
import type { Translation } from "./types";

export const zh = {
  "agents.listSeparator": "、",
  "agents.reasonSeparator": "；",

  "agents.installation.installed": "已安装",
  "agents.installation.configured-only": "只有配置",
  "agents.installation.not-found": "未发现",
  "agents.drift.unwired": "未接到网关",
  "agents.drift.replaced": "接线字段被改",
  "agents.drift.foreign-gateway": "指向其他网关",
  "agents.driftReason.missing": "缺失",
  "agents.driftReason.changed": "被修改",
  "agents.driftReason.other-key": "换成了别的 Key",
  "agents.driftReason.file-missing": "文件不存在",
  "agents.driftReason.unreadable": "无法读取",
  "agents.tier.opus": "Opus 档",
  "agents.tier.sonnet": "Sonnet 档",
  "agents.tier.haiku": "Haiku 档",
  "agents.tier.fable": "Fable 档",
  "agents.tier.subagent": "子 Agent",
  "agents.effort.none": "不推理",
  "agents.effort.minimal": "最少",
  "agents.effort.low": "低",
  "agents.effort.medium": "中",
  "agents.effort.high": "高",
  "agents.effort.xhigh": "很高",
  "agents.effort.max": "最高",
  "agents.option.codexAuth": "Codex 登录方式",
  "agents.option.codexAuth.gateway-key": "Gateway Key：经网关调用所选模型",
  "agents.option.codexAuth.chatgpt":
    "ChatGPT 登录：保留 Codex 自己的登录，可另选 HarnessHub 的模型",
  "agents.keyState.active": "可用",
  "agents.keyState.revoked": "已吊销",
  "agents.keyState.expired": "已过期",
  "agents.keyState.missing": "不存在",
  "agents.keyState.none": "无 Key",

  "agents.attention.notFound": "已接线，但本机找不到这个 Agent",
  "agents.attention.uncheckable": "无法检查配置文件",
  "agents.attention.drifted": "配置文件被改动：{kinds}",
  "agents.attention.keyMissing": "它的 Key 不存在",
  "agents.attention.keyInvalid": "它的 Key 已失效",
  "agents.attention.modelGone": "网关不再提供 {models}",

  "agents.title": "Agent",
  "agents.lede":
    "本机的编码 Agent 经网关使用的模型。点模型即可切换：先预览配置文件的改动，确认后写入，随时可以还原。",
  "agents.badge.uncheckable": "无法检查",
  "agents.badge.consistent": "一致",
  "agents.badge.attention": "需要处理",
  "agents.row.modelOf": "{name} 的模型",
  "agents.ownModel": "{name} 自己的模型",
  "agents.row.legacy": "ChatGPT 登录 · 旧接线没有 Key",
  "agents.row.chatgptOwn": "ChatGPT 登录 · 用 Codex 自己的模型",
  "agents.row.chatgptShown": "ChatGPT 登录 · 显示 {shown} / {allowed} 个模型",
  "agents.row.shown": "显示 {shown} / {allowed} 个模型",
  "agents.row.unwired": "未接线，选择模型即可预览接线",
  "agents.row.details": "详情",
  "agents.restore": "还原",
  "agents.noProvider":
    "还没有 provider：添加一个模型 provider，再给 Agent 选择模型。",
  "agents.startSetup": "开始设置",
  "agents.noModels":
    "网关还没有模型：先添加一个 provider，再给 Agent 选择模型。",
  "agents.addProvider": "添加 provider",
  "agents.needs": "{n} 个 Agent 需要处理：",
  "agents.needsReasons": "：{reasons}",
  "agents.here": "本机的 Agent",
  "agents.empty.title": "本机没有发现 Agent",
  "agents.empty.body":
    "安装 Claude Code、Codex、OpenCode 等编码 Agent 后刷新；也可以在下面为尚未安装的 Agent 预先写好配置。",
  "agents.missingCount": "未发现的 Agent（{n}）",
  "agents.missing": "未发现的 Agent",
  "agents.switchTitle": "切换 {name}",
  "agents.wireTitle": "接线 {name}",
  "agents.changeTitle": "修改 {name}",
  "agents.restoreTitle": "还原 {name}",
  "agents.restoreDescription":
    "配置文件未被改动时恢复为接线前的原样；之后改过的文件只撤销 HarnessHub 写入的项。它的 Key 随即吊销。",
  "agents.restored": "{name} 已还原（{n} 个文件）",

  "agents.detail.chatgptMode":
    "{name} 保留自己的 ChatGPT 登录：不选模型时用它自己的模型，请求经网关转发；选了 HarnessHub 的模型时经网关调用它。接线签发的 Key 写在基址中，只在本机可用。",
  "agents.detail.mainModel": "主模型",
  "agents.detail.followMain": "跟随主模型",
  "agents.detail.effort": "推理强度（effort）",
  "agents.detail.effortDefault": "默认（不设置）",
  "agents.detail.effortOption": "{label}（{effort}）",
  "agents.detail.preview": "预览改动",
  "agents.detail.keyInEnv": "Key 写入 Agent 读取的 .env",
  "agents.detail.keyInConfig": "Key 写入配置文件",
  "agents.detail.command": "命令",
  "agents.detail.configDirectories": "配置目录",
  "agents.detail.wiredAt": "接线时间",
  "agents.detail.wiring": "接线",
  "agents.detail.wireUp": "接到网关",
  "agents.detail.files": "配置文件",
  "agents.visibility.saved": "{name} 现在显示 {n} 个模型",
  "agents.visibility.notSaved": "没有保存",
  "agents.visibility.save": "保存",
  "agents.visibility.help":
    "隐藏的模型从 {name} 的模型列表和它的 Key 可用的模型中去掉，Key 不变；网关之后新增的模型默认显示。",
  "agents.visibility.filter": "筛选模型",
  "agents.visibility.locked": "正在使用的模型不能隐藏",
  "agents.visibility.inUse": "使用中",
  "agents.key.issue": "签发 Key",
  "agents.key.rotate": "换 Key",
  "agents.key.legacy":
    "这条 ChatGPT 接线来自之前的版本，没有 Key：{name} 自己的模型照常可用，HarnessHub 的模型会被拒绝（401）。签发一把 Key 后它也能使用 HarnessHub 的模型。",
  "agents.key.issueTitle": "给 {name} 签发 Key",
  "agents.key.rotateTitle": "给 {name} 换一把新 Key",
  "agents.key.issueDescription":
    "以当前的选择重新接线并签发第一把 Key，写入它的配置文件。正在运行的实例要重启后才用这把 Key。",
  "agents.key.rotateDescription":
    "以当前的模型与列表重新接线并签发新 Key，旧 Key 立即失效。正在运行的实例要重启后才用新 Key。",
  "agents.key.issued": "{name} 已有 Key",
  "agents.key.rotated": "{name} 已换用新 Key",
  "agents.findings.file": "文件",
  "agents.findings.field": "字段",
  "agents.findings.change": "变化",
  "agents.findings.item": "{kind}（{reason}）",
  "agents.findings.none": "与接线时写入的内容一致。",

  "agents.wire.done": "{name} 已接线，重启正在运行的 {name} 后生效",
  "agents.wire.description":
    "确认后写入 {name} 自己的配置文件；写入前先备份，之后可以还原。每次接线都签发一把新 Key，旧 Key 随即失效。",
  "agents.wire.chatgpt":
    "{name} 保留自己的 ChatGPT 登录，Key 写在它的网关基址中。",
  "agents.wire.unchanged": "当前接线已经是这样，没有要写入的改动。",
  "agents.wire.computing": "正在计算改动",
  "agents.wire.confirm": "确认写入",
  "agents.plan.noChanges": "没有文件改动。",
  "agents.plan.modify": "修改",
  "agents.plan.create": "新建",
  "agents.plan.noDiff": "（无改动）",
  "agents.plan.keyNote":
    "Key 以 hhk_a_xxxx… 显示；实际的 Key 只写入上面的文件，不会显示或保存在别处。",

  "agents.picker.models": "模型",
  "agents.picker.groups": "路由组",
  "agents.picker.autoGroups": "自动路由组",
  "agents.picker.noMatch": "没有匹配的模型",
  "agents.picker.noModels": "网关还没有模型，先添加 provider",
  "agents.picker.members": "{n} 个成员",
  "agents.picker.context": "{tokens} 上下文",
  "agents.picker.factsUnknown": "窗口与价格未知",
  "agents.picker.priceUnknown": "价格未知",
  "agents.picker.trigger": "{label}：{value}",
  "agents.picker.unset": "未选择",
  "agents.picker.choose": "选择模型",
  "agents.picker.searchPlaceholder": "搜索模型或 provider",
  "agents.picker.search": "搜索模型",

  "agents.profiles.chatgpt": "ChatGPT 登录",
  "agents.profiles.saved": "已保存 Profile {name}（{n} 个 Agent）",
  "agents.profiles.save": "保存当前接线",
  "agents.profiles.saveDescription":
    "保存每个已接线 Agent 的模型、档位、effort 与选项；隐藏的模型与 Key 不属于 Profile。",
  "agents.profiles.name": "名称",
  "agents.profiles.nameHint":
    "1–64 个字母、数字、点、下划线或连字符，以字母或数字开头。",
  "agents.profiles.replaces": "已有同名 Profile，保存会替换它。",
  "agents.profiles.replace": "替换",
  "agents.profiles.saveAction": "保存",
  "agents.profiles.applied": "已应用 Profile {name}：切换了 {n} 个 Agent",
  "agents.profiles.applyTitle": "应用 Profile {name}",
  "agents.profiles.applyDescription":
    "选择与当前接线不同的 Agent 会按下面的改动重新接线（新 Key、写前备份）；不在 Profile 中的 Agent 不受影响。遇到第一个失败即停止。",
  "agents.profiles.willSwitch": "将切换",
  "agents.profiles.same": "已经一致",
  "agents.profiles.switch": "切换 {n} 个 Agent",
  "agents.profiles.noChanges": "没有改动",
  "agents.profiles.lede":
    "一组 Agent 的模型选择。保存当前的接线，之后一键切换回来：例如工作与个人用不同的 provider。",
  "agents.profiles.summary": "{n} 个 Agent · 更新于 {time}",
  "agents.profiles.previewApply": "预览并应用",
  "agents.profiles.deleteLabel": "删除 {name}",
  "agents.profiles.empty": "还没有 Profile",
  "agents.profiles.emptyBody":
    "先在 Agent 页面接好线，再把这组选择保存为 Profile。",
  "agents.profiles.deleteTitle": "删除 Profile {name}",
  "agents.profiles.deleteDescription":
    "只删除保存的选择，不改动任何 Agent 的配置。",
  "agents.profiles.delete": "删除",
  "agents.profiles.deleted": "已删除 Profile {name}",

  "agents.firstRun.step.provider": "Provider 与 Key",
  "agents.firstRun.step.models": "模型列表",
  "agents.firstRun.step.agents": "Agent",
  "agents.firstRun.step.model": "默认模型",
  "agents.firstRun.step.review": "确认改动",
  "agents.firstRun.steps": "步骤",
  "agents.firstRun.someFailed": "部分 Agent 没有接线",
  "agents.firstRun.incomplete": "接线未全部完成",
  "agents.firstRun.done": "设置完成，重启正在运行的 Agent 后生效",
  "agents.firstRun.label": "开始使用",
  "agents.firstRun.title": "开始使用 HarnessHub",
  "agents.firstRun.lede":
    "添加一个模型 provider，再让本机的编码 Agent 经网关使用它。与终端里的 hh init 相同，每一步都可以之后在各个页面修改。",
  "agents.firstRun.skipProvider": "跳过，稍后添加",
  "agents.firstRun.addProvider": "添加并继续",
  "agents.firstRun.added": "已添加 provider {id}{region}{plan}。",
  "agents.firstRun.region": "，区域 {region}",
  "agents.firstRun.plan": "，套餐 {plan}",
  "agents.firstRun.refreshing": "正在从上游读取模型列表…",
  "agents.firstRun.refreshFailed":
    "读取模型列表失败（{error}），使用预设中的列表。",
  "agents.firstRun.models": "{name} 提供 {n} 个模型：{list}",
  "agents.firstRun.modelsMore": "{name} 提供 {n} 个模型：{list} 等",
  "agents.firstRun.noModels":
    "{name} 提供 0 个模型。可以之后在 Provider 页手动添加。",
  "agents.firstRun.stop": "到此为止",
  "agents.firstRun.continue": "继续",
  "agents.firstRun.chooseAgents":
    "选择要经网关使用这个 provider 的 Agent。每个 Agent 写入自己的配置文件，写入前先备份，随时可以还原。",
  "agents.firstRun.now": "现在 {model}",
  "agents.firstRun.skipWiring": "跳过接线",
  "agents.firstRun.chooseModel":
    "{names} 默认使用的模型。Claude Code 的各档位跟随这个模型，之后可以在 Agent 详情中分别设置。",
  "agents.firstRun.back": "上一步",
  "agents.firstRun.noAgents":
    "本机没有发现编码 Agent；安装 Claude Code、Codex、OpenCode 等之后在 Agent 页接线。",
  "agents.firstRun.providerNoModels":
    "这个 provider 还没有模型；在 Provider 页添加模型后，再到 Agent 页接线。",
  "agents.firstRun.noneChosen":
    "没有选择 Agent。之后可以在 Agent 页为它们选择模型。",
  "agents.firstRun.results": "结果",
  "agents.firstRun.wired": "已接线到 {model}",
  "agents.firstRun.unchanged": "已经这样接线，未改动",
  "agents.firstRun.failed": "接线失败：{error}",
  "agents.firstRun.alreadyWired": "已经这样接线",
  "agents.firstRun.writeNote":
    "确认后依次写入；每个 Agent 签发一把自己的 Key。正在运行的 Agent 重启后生效。",
  "agents.firstRun.finish": "完成",
  "agents.firstRun.write": "写入 {n} 个 Agent",
} as const;

export const en: Translation<typeof zh> = {
  "agents.listSeparator": ", ",
  "agents.reasonSeparator": "; ",

  "agents.installation.installed": "Installed",
  "agents.installation.configured-only": "Configuration only",
  "agents.installation.not-found": "Not found",
  "agents.drift.unwired": "Not wired to the gateway",
  "agents.drift.replaced": "Wired fields changed",
  "agents.drift.foreign-gateway": "Points to another gateway",
  "agents.driftReason.missing": "missing",
  "agents.driftReason.changed": "changed",
  "agents.driftReason.other-key": "replaced with another key",
  "agents.driftReason.file-missing": "file does not exist",
  "agents.driftReason.unreadable": "cannot be read",
  "agents.tier.opus": "Opus tier",
  "agents.tier.sonnet": "Sonnet tier",
  "agents.tier.haiku": "Haiku tier",
  "agents.tier.fable": "Fable tier",
  "agents.tier.subagent": "Subagent",
  "agents.effort.none": "No reasoning",
  "agents.effort.minimal": "Minimal",
  "agents.effort.low": "Low",
  "agents.effort.medium": "Medium",
  "agents.effort.high": "High",
  "agents.effort.xhigh": "Very high",
  "agents.effort.max": "Maximum",
  "agents.option.codexAuth": "Codex sign-in",
  "agents.option.codexAuth.gateway-key":
    "Gateway Key: call the chosen model through the gateway",
  "agents.option.codexAuth.chatgpt":
    "ChatGPT login: keep Codex's own login, optionally with a HarnessHub model",
  "agents.keyState.active": "Active",
  "agents.keyState.revoked": "Revoked",
  "agents.keyState.expired": "Expired",
  "agents.keyState.missing": "Does not exist",
  "agents.keyState.none": "No key",

  "agents.attention.notFound":
    "Wired, but this agent cannot be found on this computer",
  "agents.attention.uncheckable": "Its configuration files cannot be checked",
  "agents.attention.drifted": "Its configuration files were changed: {kinds}",
  "agents.attention.keyMissing": "Its key does not exist",
  "agents.attention.keyInvalid": "Its key no longer works",
  "agents.attention.modelGone": "The gateway no longer offers {models}",

  "agents.title": "Agents",
  "agents.lede":
    "The models that the coding agents on this computer use through the gateway. Pick a model to switch: the changes to the configuration files are previewed first, written after you confirm, and can be restored at any time.",
  "agents.badge.uncheckable": "Cannot check",
  "agents.badge.consistent": "In sync",
  "agents.badge.attention": "Needs attention",
  "agents.row.modelOf": "{name}'s model",
  "agents.ownModel": "{name}'s own model",
  "agents.row.legacy": "ChatGPT login · older wiring without a key",
  "agents.row.chatgptOwn": "ChatGPT login · uses Codex's own model",
  "agents.row.chatgptShown":
    "ChatGPT login · showing {shown} of {allowed, plural, one {# model} other {# models}}",
  "agents.row.shown":
    "Showing {shown} of {allowed, plural, one {# model} other {# models}}",
  "agents.row.unwired": "Not wired; pick a model to preview the wiring",
  "agents.row.details": "Details",
  "agents.restore": "Restore",
  "agents.noProvider":
    "No provider yet: add a model provider, then pick models for the agents.",
  "agents.startSetup": "Start setup",
  "agents.noModels":
    "The gateway has no models yet: add a provider first, then pick models for the agents.",
  "agents.addProvider": "Add a provider",
  "agents.needs":
    "{n, plural, one {# agent needs} other {# agents need}} attention:",
  "agents.needsReasons": ": {reasons}",
  "agents.here": "Agents on this computer",
  "agents.empty.title": "No agents found on this computer",
  "agents.empty.body":
    "Install coding agents such as Claude Code, Codex or OpenCode, then refresh; you can also write the configuration ahead of time for agents that are not installed yet, below.",
  "agents.missingCount": "Agents not found ({n})",
  "agents.missing": "Agents not found",
  "agents.switchTitle": "Switch {name}",
  "agents.wireTitle": "Wire {name}",
  "agents.changeTitle": "Change {name}",
  "agents.restoreTitle": "Restore {name}",
  "agents.restoreDescription":
    "Files that were not changed since are restored to what they were before the wiring; in files changed since, only the entries HarnessHub wrote are undone. Its key is revoked at once.",
  "agents.restored":
    "{name} restored ({n, plural, one {# file} other {# files}})",

  "agents.detail.chatgptMode":
    "{name} keeps its own ChatGPT login: without a model it uses its own models, with its requests forwarded through the gateway; with a HarnessHub model it calls that model through the gateway. The key that wiring issues is written into the base URL and works on this computer only.",
  "agents.detail.mainModel": "Main model",
  "agents.detail.followMain": "Follow the main model",
  "agents.detail.effort": "Reasoning effort",
  "agents.detail.effortDefault": "Default (not set)",
  "agents.detail.effortOption": "{label} ({effort})",
  "agents.detail.preview": "Preview changes",
  "agents.detail.keyInEnv": "Key written to the .env the agent reads",
  "agents.detail.keyInConfig": "Key written to the configuration file",
  "agents.detail.command": "Command",
  "agents.detail.configDirectories": "Configuration directories",
  "agents.detail.wiredAt": "Wired at",
  "agents.detail.wiring": "Wiring",
  "agents.detail.wireUp": "Wire to the gateway",
  "agents.detail.files": "Configuration files",
  "agents.visibility.saved":
    "{name} now shows {n, plural, one {# model} other {# models}}",
  "agents.visibility.notSaved": "Not saved",
  "agents.visibility.save": "Save",
  "agents.visibility.help":
    "Hidden models are removed from {name}'s model list and from the models its key may use; the key stays the same. Models the gateway adds later are shown by default.",
  "agents.visibility.filter": "Filter models",
  "agents.visibility.locked": "A model in use cannot be hidden",
  "agents.visibility.inUse": "In use",
  "agents.key.issue": "Issue a key",
  "agents.key.rotate": "Rotate key",
  "agents.key.legacy":
    "This ChatGPT wiring comes from an earlier version and has no key: {name}'s own models work as before, but HarnessHub's models are refused (401). After a key is issued it can use HarnessHub's models too.",
  "agents.key.issueTitle": "Issue a key for {name}",
  "agents.key.rotateTitle": "Give {name} a new key",
  "agents.key.issueDescription":
    "Wires again with the current choices and issues the first key, written to its configuration file. Running instances use this key only after a restart.",
  "agents.key.rotateDescription":
    "Wires again with the current model and list and issues a new key; the old key stops working at once. Running instances use the new key only after a restart.",
  "agents.key.issued": "{name} now has a key",
  "agents.key.rotated": "{name} now uses a new key",
  "agents.findings.file": "File",
  "agents.findings.field": "Field",
  "agents.findings.change": "Change",
  "agents.findings.item": "{kind} ({reason})",
  "agents.findings.none": "Matches what the wiring wrote.",

  "agents.wire.done":
    "{name} is wired; restart a running {name} for it to take effect",
  "agents.wire.description":
    "Once you confirm, this is written to {name}'s own configuration files; they are backed up first and can be restored later. Every wiring issues a new key, and the old key stops working at once.",
  "agents.wire.chatgpt":
    "{name} keeps its own ChatGPT login; the key is written into its gateway base URL.",
  "agents.wire.unchanged":
    "The wiring is already like this; there are no changes to write.",
  "agents.wire.computing": "Computing the changes",
  "agents.wire.confirm": "Write the changes",
  "agents.plan.noChanges": "No file changes.",
  "agents.plan.modify": "Change",
  "agents.plan.create": "Create",
  "agents.plan.noDiff": "(no changes)",
  "agents.plan.keyNote":
    "Keys show as hhk_a_xxxx…; the real key is written only to the files above, and is never shown or kept anywhere else.",

  "agents.picker.models": "Models",
  "agents.picker.groups": "Route groups",
  "agents.picker.autoGroups": "Automatic route groups",
  "agents.picker.noMatch": "No matching models",
  "agents.picker.noModels":
    "The gateway has no models yet; add a provider first",
  "agents.picker.members": "{n, plural, one {# member} other {# members}}",
  "agents.picker.context": "{tokens} context",
  "agents.picker.factsUnknown": "Window and price unknown",
  "agents.picker.priceUnknown": "Price unknown",
  "agents.picker.trigger": "{label}: {value}",
  "agents.picker.unset": "Not chosen",
  "agents.picker.choose": "Choose a model",
  "agents.picker.searchPlaceholder": "Search models or providers",
  "agents.picker.search": "Search models",

  "agents.profiles.chatgpt": "ChatGPT login",
  "agents.profiles.saved":
    "Saved the profile {name} ({n, plural, one {# agent} other {# agents}})",
  "agents.profiles.save": "Save the current wiring",
  "agents.profiles.saveDescription":
    "Saves the model, tiers, effort and options of every wired agent; hidden models and keys are not part of a profile.",
  "agents.profiles.name": "Name",
  "agents.profiles.nameHint":
    "1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
  "agents.profiles.replaces":
    "A profile with this name exists; saving replaces it.",
  "agents.profiles.replace": "Replace",
  "agents.profiles.saveAction": "Save",
  "agents.profiles.applied":
    "Applied the profile {name}: switched {n, plural, one {# agent} other {# agents}}",
  "agents.profiles.applyTitle": "Apply the profile {name}",
  "agents.profiles.applyDescription":
    "Agents whose choices differ from their current wiring are wired again with the changes below (new key, backed up before writing); agents that are not in the profile are not affected. It stops at the first failure.",
  "agents.profiles.willSwitch": "Will switch",
  "agents.profiles.same": "Already the same",
  "agents.profiles.switch":
    "Switch {n, plural, one {# agent} other {# agents}}",
  "agents.profiles.noChanges": "No changes",
  "agents.profiles.lede":
    "A set of model choices for the agents. Save the current wiring and switch back to it in one step later: for example, different providers for work and personal use.",
  "agents.profiles.summary":
    "{n, plural, one {# agent} other {# agents}} · updated {time}",
  "agents.profiles.previewApply": "Preview and apply",
  "agents.profiles.deleteLabel": "Delete {name}",
  "agents.profiles.empty": "No profiles yet",
  "agents.profiles.emptyBody":
    "Wire the agents on the Agents page first, then save those choices as a profile.",
  "agents.profiles.deleteTitle": "Delete the profile {name}",
  "agents.profiles.deleteDescription":
    "Deletes only the saved choices; no agent's configuration changes.",
  "agents.profiles.delete": "Delete",
  "agents.profiles.deleted": "Deleted the profile {name}",

  "agents.firstRun.step.provider": "Provider and key",
  "agents.firstRun.step.models": "Model list",
  "agents.firstRun.step.agents": "Agents",
  "agents.firstRun.step.model": "Default model",
  "agents.firstRun.step.review": "Review changes",
  "agents.firstRun.steps": "Steps",
  "agents.firstRun.someFailed": "Some agents were not wired",
  "agents.firstRun.incomplete": "The wiring did not complete for every agent",
  "agents.firstRun.done":
    "Setup is complete; restart running agents for it to take effect",
  "agents.firstRun.label": "Get started",
  "agents.firstRun.title": "Get started with HarnessHub",
  "agents.firstRun.lede":
    "Add a model provider, then let the coding agents on this computer use it through the gateway. This is the same as hh init in a terminal; every step can be changed later on its own page.",
  "agents.firstRun.skipProvider": "Skip; add one later",
  "agents.firstRun.addProvider": "Add and continue",
  "agents.firstRun.added": "Added the provider {id}{region}{plan}.",
  "agents.firstRun.region": ", region {region}",
  "agents.firstRun.plan": ", plan {plan}",
  "agents.firstRun.refreshing": "Reading the model list from the upstream…",
  "agents.firstRun.refreshFailed":
    "Reading the model list failed ({error}); the preset's list is used.",
  "agents.firstRun.models":
    "{name} offers {n, plural, one {# model} other {# models}}: {list}",
  "agents.firstRun.modelsMore":
    "{name} offers {n, plural, one {# model} other {# models}}: {list} and more",
  "agents.firstRun.noModels":
    "{name} offers 0 models. You can add them by hand on the Providers page later.",
  "agents.firstRun.stop": "Stop here",
  "agents.firstRun.continue": "Continue",
  "agents.firstRun.chooseAgents":
    "Choose the agents that use this provider through the gateway. Each agent's own configuration files are written, backed up first, and can be restored at any time.",
  "agents.firstRun.now": "Now {model}",
  "agents.firstRun.skipWiring": "Skip wiring",
  "agents.firstRun.chooseModel":
    "The model that {names} use by default. Claude Code's tiers follow this model; you can set them one by one in the agent's details later.",
  "agents.firstRun.back": "Back",
  "agents.firstRun.noAgents":
    "No coding agents were found on this computer; install Claude Code, Codex, OpenCode or another, then wire them on the Agents page.",
  "agents.firstRun.providerNoModels":
    "This provider has no models yet; add models on the Providers page, then wire the agents on the Agents page.",
  "agents.firstRun.noneChosen":
    "No agents were chosen. You can pick models for them on the Agents page later.",
  "agents.firstRun.results": "Results",
  "agents.firstRun.wired": "Wired to {model}",
  "agents.firstRun.unchanged": "Already wired this way; not changed",
  "agents.firstRun.failed": "Wiring failed: {error}",
  "agents.firstRun.alreadyWired": "Already wired this way",
  "agents.firstRun.writeNote":
    "Once you confirm, the agents are written one after another; each gets its own key. Running agents take the change after a restart.",
  "agents.firstRun.finish": "Done",
  "agents.firstRun.write": "Write {n, plural, one {# agent} other {# agents}}",
};
