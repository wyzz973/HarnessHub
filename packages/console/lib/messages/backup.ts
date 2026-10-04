// SPDX-License-Identifier: MIT
/** Messages of the settings' backup, restore and sync tab (see ./types.ts). */
import type { Translation } from "./types";

export const zh = {
  "backup.title": "备份与同步",
  "backup.lede": "把模型平面的设置带到另一台电脑，或者在几台电脑之间保持一致。",
  "backup.passphrase": "口令",
  "backup.passphraseAgain": "再输入一次",
  "backup.passphraseMismatch": "两次输入的口令不一致",
  "backup.keepStored": "留空保留已保存的",
  "backup.listSeparator": "、",

  "backup.backup.title": "备份",
  "backup.backup.lede":
    "把 provider、凭据、路由组、模型覆盖、Agent 接线、Profile 与 Library 打包成一个用口令加密的文件。",
  "backup.backup.keys": "包含凭据的值（API Key 与 Library 的秘密）",
  "backup.backup.hintWithKeys":
    "口令只用于这一次加密，页面与守护进程都不保存；忘记口令就无法打开这个文件。文件含有 Key 的值，请像保管 Key 一样保管它。Gateway Key 的文本、用量与会话不在备份中。",
  "backup.backup.hintWithoutKeys":
    "口令只用于这一次加密，页面与守护进程都不保存；忘记口令就无法打开这个文件。不含 Key 时，凭据只保留名称，恢复后需要重新填写 Key。Gateway Key 的文本、用量与会话不在备份中。",
  "backup.backup.download": "下载备份",
  "backup.backup.downloaded": "已下载备份 {file}",

  "backup.file.notJson": "这不是 HarnessHub 备份文件：内容不是 JSON",
  "backup.file.noFormat":
    "这不是 HarnessHub 备份文件：缺少 format: harnesshub-backup",
  "backup.file.tooLarge": "文件超过 64 MiB，不是 HarnessHub 备份",
  "backup.file.readFailed": "读取文件失败",

  "backup.restore.title": "恢复",
  "backup.restore.lede":
    "从备份文件恢复：同名的记录被替换，其余新增，本机的其他记录不删除。先预览，确认后再恢复。",
  "backup.restore.chooseFile": "选择备份文件",
  "backup.restore.noFile": "尚未选择",
  "backup.restore.agents": "重新接线本机已安装的 Agent",
  "backup.restore.library": "带入 Library（指令集、MCP 服务与 Skills）",
  "backup.restore.libraryNote":
    "恢复只把 Library 的条目带入 HarnessHub；恢复之后会预览把它们写入本机 Agent 的改动，再由你确认。",
  "backup.restore.syncTitle": "把恢复的 Library 写入 Agent",
  "backup.restore.noLibraryAgents":
    "本机没有安装 Library 支持的 Agent；安装后在 Library 页同步。",
  "backup.restore.preview": "预览恢复",
  "backup.restore.restore": "恢复",
  "backup.restore.done": "完成",
  "backup.restore.restored": "已恢复",
  "backup.restore.madeWithKeys":
    "备份生成于 {time}，来自 {app}；带有凭据的值。",
  "backup.restore.madeWithoutKeys":
    "备份生成于 {time}，来自 {app}；不带凭据的值：本机已有的 Key 保留，其余需要重新填写。",
  "backup.restore.noChanges": "没有变化",
  "backup.restore.added": "新增",
  "backup.restore.replaced": "替换",
  "backup.restore.needKey": "需要填写 Key",
  "backup.restore.signInAgain": "订阅账号不随备份恢复，在本机重新登录",
  "backup.restore.signedInHere": "本机同名的订阅 provider，保留",
  "backup.restore.groups": "路由组",
  "backup.restore.groupsSkipped": "跳过（成员的 provider 不存在）",
  "backup.restore.overrides": "模型覆盖",
  "backup.restore.overrideCount": "{count} 条",
  "backup.restore.addedInstructions": "新增指令集",
  "backup.restore.replacedInstructions": "替换指令集",
  "backup.restore.addedMcp": "新增 MCP",
  "backup.restore.replacedMcp": "替换 MCP",
  "backup.restore.needSecret": "缺少秘密、已去掉",
  "backup.restore.addedSkills": "新增 Skill",
  "backup.restore.replacedSkills": "替换 Skill",
  "backup.restore.incomplete": "缺少大文件",
  "backup.restore.refused": "被拒绝",
  "backup.restore.libraryLeftOut": "不带入",
  "backup.restore.share": "局域网共享",
  "backup.restore.share.apply": "应用备份中的局域网共享设置",
  "backup.restore.share.unchanged": "与本机相同",
  "backup.restore.share.absent": "备份中没有",
  "backup.restore.share.unavailable": "无法应用",
  "backup.restore.catalog": "模型目录",
  "backup.restore.catalogDiffers":
    "备份中的目录设置与本机不同；它来自配置文件，恢复不改。",
  "backup.restore.model": "模型",
  "backup.restore.result": "结果",
  "backup.restore.planned": "将要",
  "backup.restore.ownSignIn": "自行登录",
  "backup.restore.wireFailed": "接线失败",
  "backup.restore.rewired": "已重新接线",
  "backup.restore.clientKeys":
    "Key 的文本不在备份中，这些 client Key 需要重新签发：",
  "backup.restore.issue": "去签发",
  "backup.agentAction.wire": "重新接线",
  "backup.agentAction.unchanged": "已相同，不动",
  "backup.agentAction.skip-disabled": "跳过：未要求接线",
  "backup.agentAction.skip-not-installed": "跳过：本机未安装",
  "backup.agentAction.skip-unknown": "跳过：未知 Agent",
  "backup.agentAction.skip-unavailable": "跳过：守护进程不能接线",

  "backup.sync.title": "同步",
  "backup.sync.lede":
    "经 WebDAV 或 S3 兼容存储在多台电脑之间自动同步 provider、Agent 接线、Profile 与 Library；两边都改的部分保留最后修改的一边，另一边的副本存在本机。",
  "backup.sync.now": "立即同步",
  "backup.sync.edit": "修改",
  "backup.sync.off": "关闭",
  "backup.sync.on": "开启同步",
  "backup.sync.target": "目标",
  "backup.sync.user": "用户名",
  "backup.sync.pathStyle": "路径式",
  "backup.sync.virtualHost": "虚拟主机式",
  "backup.sync.contentLabel": "内容",
  "backup.sync.content": "{parts}；{keys}",
  "backup.sync.partsWithAgents":
    "provider 与路由、Profile、Library、Agent 接线",
  "backup.sync.partsWithoutAgents":
    "provider 与路由、Profile、Library（不含 Agent 接线）",
  "backup.sync.withKeys": "带凭据的值",
  "backup.sync.withoutKeys": "不带凭据的值",
  "backup.sync.last": "上次同步",
  "backup.sync.next": "下次同步",
  "backup.sync.lastError": "最近一次同步失败：{error}",
  "backup.sync.noticeAt": "{time} 的同步中两边都有改动：",
  "backup.sync.noticeHere": "本机的{parts}被服务器的版本替换",
  "backup.sync.noticeThere": "服务器的{parts}被本机的版本替换",
  "backup.sync.noticeKept":
    "服务器上已删除、但仍被 Gateway Key 使用而保留：{names}",
  "backup.sync.noticeSaved": "被替换的副本（加密）保存在 {path}",
  "backup.sync.disabled":
    "同步未开启。局域网共享、目录设置、client Key 与用量不参与同步。",
  "backup.sync.synced": "已同步",
  "backup.sync.failed": "同步失败",
  "backup.sync.offTitle": "关闭同步",
  "backup.sync.offBody":
    "删除同步设置、状态、服务器副本的本机缓存以及保存的密码与口令。冲突副本与服务器上的文件保留。",
  "backup.sync.turnedOff": "同步已关闭",
  "backup.sync.part.providers": "provider 与路由",
  "backup.sync.part.agents": "Agent 接线",
  "backup.sync.part.profiles": "Profile",
  "backup.sync.part.library": "Library",
  "backup.sync.part.features": "网关功能",

  "backup.syncDialog.edit": "修改同步",
  "backup.syncDialog.on": "开启同步",
  "backup.syncDialog.description":
    "经 WebDAV 目录或 S3 兼容存储桶在多台电脑之间同步。服务器只保存用口令加密的副本；每台电脑使用同一个口令。",
  "backup.syncDialog.kind": "同步方式",
  "backup.syncDialog.s3": "S3 兼容存储",
  "backup.syncDialog.bucket": "存储桶",
  "backup.syncDialog.directory": "WebDAV 目录",
  "backup.syncDialog.copyHint":
    "副本保存在其中的 harnesshub/harnesshub.harnesshub-backup。",
  "backup.syncDialog.password": "密码",
  "backup.syncDialog.endpointPlaceholder": "缺省为 AWS 该区域的地址",
  "backup.syncDialog.region": "区域",
  "backup.syncDialog.addressing": "地址形式",
  "backup.syncDialog.auto": "自动",
  "backup.syncDialog.pathStyle": "路径式（endpoint/bucket）",
  "backup.syncDialog.virtualHost": "虚拟主机式（bucket.endpoint）",
  "backup.syncDialog.warning":
    "为了无人值守地同步，口令与目标的密码保存在本机的秘密存储中：能读取这个账户秘密的人也能打开服务器上的副本。",
  "backup.syncDialog.keys": "同步凭据的值（加密后上传）",
  "backup.syncDialog.agents": "同步 Agent 接线",
  "backup.syncDialog.save": "保存并同步",
  "backup.syncDialog.done": "同步已开启，第一次同步已完成",
  "backup.syncDialog.firstFailed": "设置已保存，但第一次同步失败：{message}",
  "backup.syncDialog.needWebdav": "填写 WebDAV 目录的地址（https://…）",
  "backup.syncDialog.needBucket":
    "填写存储桶（s3://bucket 或 s3://bucket/prefix）",
  "backup.syncDialog.needAccessKey": "填写 S3 的 Access Key ID",
  "backup.syncDialog.needPassphrase":
    "开启同步需要一个口令，用来加密服务器上的副本",
} as const;

export const en: Translation<typeof zh> = {
  "backup.title": "Backup and sync",
  "backup.lede":
    "Take the model plane's settings to another computer, or keep several computers the same.",
  "backup.passphrase": "Passphrase",
  "backup.passphraseAgain": "Enter it again",
  "backup.passphraseMismatch": "The two passphrases do not match",
  "backup.keepStored": "Leave empty to keep the stored one",
  "backup.listSeparator": ", ",

  "backup.backup.title": "Backup",
  "backup.backup.lede":
    "Pack providers, credentials, route groups, model overrides, agent wiring, profiles and the Library into one file encrypted with a passphrase.",
  "backup.backup.keys":
    "Include the credentials' values (API keys and the Library's secrets)",
  "backup.backup.hintWithKeys":
    "The passphrase is used for this encryption only; neither the page nor the daemon keeps it, and without it the file cannot be opened. The file contains key values, so keep it as safe as the keys themselves. Gateway Key texts, usage and sessions are not in the backup.",
  "backup.backup.hintWithoutKeys":
    "The passphrase is used for this encryption only; neither the page nor the daemon keeps it, and without it the file cannot be opened. Without keys, credentials keep only their names, and their keys must be entered again after a restore. Gateway Key texts, usage and sessions are not in the backup.",
  "backup.backup.download": "Download backup",
  "backup.backup.downloaded": "Downloaded the backup {file}",

  "backup.file.notJson":
    "This is not a HarnessHub backup file: its content is not JSON",
  "backup.file.noFormat":
    "This is not a HarnessHub backup file: it lacks format: harnesshub-backup",
  "backup.file.tooLarge":
    "The file is larger than 64 MiB, so it is not a HarnessHub backup",
  "backup.file.readFailed": "The file could not be read",

  "backup.restore.title": "Restore",
  "backup.restore.lede":
    "Restore from a backup file: records with the same name are replaced and the others added; no other record on this computer is deleted. Preview first, then restore after confirming.",
  "backup.restore.chooseFile": "Choose a backup file",
  "backup.restore.noFile": "None chosen yet",
  "backup.restore.agents": "Wire the agents installed on this computer again",
  "backup.restore.library":
    "Bring in the Library (instruction sets, MCP servers and skills)",
  "backup.restore.libraryNote":
    "Restoring only brings the Library's items into HarnessHub; after the restore, the changes that write them into this computer's agents are previewed for you to confirm.",
  "backup.restore.syncTitle": "Write the restored Library into the agents",
  "backup.restore.noLibraryAgents":
    "No agent that the Library supports is installed on this computer; after installing one, sync on the Library page.",
  "backup.restore.preview": "Preview the restore",
  "backup.restore.restore": "Restore",
  "backup.restore.done": "Done",
  "backup.restore.restored": "Restored",
  "backup.restore.madeWithKeys":
    "The backup was made on {time} by {app}; it carries the credentials' values.",
  "backup.restore.madeWithoutKeys":
    "The backup was made on {time} by {app}; it carries no credential values: keys already on this computer are kept, and the others must be entered again.",
  "backup.restore.noChanges": "No changes",
  "backup.restore.added": "Added",
  "backup.restore.replaced": "Replaced",
  "backup.restore.needKey": "Need a key",
  "backup.restore.signInAgain":
    "Subscription accounts are not restored from backups; sign in again on this computer",
  "backup.restore.signedInHere":
    "Subscription providers of the same name on this computer, kept",
  "backup.restore.groups": "Route groups",
  "backup.restore.groupsSkipped":
    "Skipped (a member's provider does not exist)",
  "backup.restore.overrides": "Model overrides",
  "backup.restore.overrideCount": "{count}",
  "backup.restore.addedInstructions": "Added instruction sets",
  "backup.restore.replacedInstructions": "Replaced instruction sets",
  "backup.restore.addedMcp": "Added MCP servers",
  "backup.restore.replacedMcp": "Replaced MCP servers",
  "backup.restore.needSecret": "Secrets missing, left out",
  "backup.restore.addedSkills": "Added skills",
  "backup.restore.replacedSkills": "Replaced skills",
  "backup.restore.incomplete": "Large files missing",
  "backup.restore.refused": "Refused",
  "backup.restore.libraryLeftOut": "Not brought in",
  "backup.restore.share": "LAN sharing",
  "backup.restore.share.apply": "The backup's LAN sharing settings are applied",
  "backup.restore.share.unchanged": "The same as on this computer",
  "backup.restore.share.absent": "Not in the backup",
  "backup.restore.share.unavailable": "Cannot be applied",
  "backup.restore.catalog": "Model catalog",
  "backup.restore.catalogDiffers":
    "The backup's catalog settings differ from this computer's; they come from the configuration file, which a restore does not change.",
  "backup.restore.model": "Model",
  "backup.restore.result": "Result",
  "backup.restore.planned": "Will",
  "backup.restore.ownSignIn": "Signs in by itself",
  "backup.restore.wireFailed": "Wiring failed",
  "backup.restore.rewired": "Wired again",
  "backup.restore.clientKeys":
    "Key texts are not in backups, so these client keys must be issued again:",
  "backup.restore.issue": "Issue them",
  "backup.agentAction.wire": "Wire again",
  "backup.agentAction.unchanged": "Already the same; left as it is",
  "backup.agentAction.skip-disabled": "Skipped: wiring not requested",
  "backup.agentAction.skip-not-installed":
    "Skipped: not installed on this computer",
  "backup.agentAction.skip-unknown": "Skipped: unknown agent",
  "backup.agentAction.skip-unavailable":
    "Skipped: the daemon cannot wire agents",

  "backup.sync.title": "Sync",
  "backup.sync.lede":
    "Sync providers, agent wiring, profiles and the Library between computers automatically through WebDAV or S3-compatible storage; where both sides changed a part, the side changed last is kept, and a copy of the other side is stored on this computer.",
  "backup.sync.now": "Sync now",
  "backup.sync.edit": "Edit",
  "backup.sync.off": "Turn off",
  "backup.sync.on": "Turn on sync",
  "backup.sync.target": "Target",
  "backup.sync.user": "User name",
  "backup.sync.pathStyle": "path-style",
  "backup.sync.virtualHost": "virtual-hosted",
  "backup.sync.contentLabel": "Content",
  "backup.sync.content": "{parts}; {keys}",
  "backup.sync.partsWithAgents":
    "Providers and routing, profiles, the Library, agent wiring",
  "backup.sync.partsWithoutAgents":
    "Providers and routing, profiles, the Library (without agent wiring)",
  "backup.sync.withKeys": "with the credentials' values",
  "backup.sync.withoutKeys": "without the credentials' values",
  "backup.sync.last": "Last sync",
  "backup.sync.next": "Next sync",
  "backup.sync.lastError": "The last sync failed: {error}",
  "backup.sync.noticeAt": "Both sides had changes in the sync of {time}:",
  "backup.sync.noticeHere":
    "This computer's {parts} replaced by the server's version",
  "backup.sync.noticeThere":
    "The server's {parts} replaced by this computer's version",
  "backup.sync.noticeKept":
    "Deleted on the server but kept because Gateway Keys still use them: {names}",
  "backup.sync.noticeSaved":
    "The replaced copies (encrypted) are kept in {path}",
  "backup.sync.disabled":
    "Sync is off. LAN sharing, catalog settings, client keys and usage are never synced.",
  "backup.sync.synced": "Synced",
  "backup.sync.failed": "Sync failed",
  "backup.sync.offTitle": "Turn off sync",
  "backup.sync.offBody":
    "Deletes the sync settings, its state, this computer's cache of the server copy and the stored password and passphrase. Conflict copies and the file on the server are kept.",
  "backup.sync.turnedOff": "Sync is off",
  "backup.sync.part.providers": "providers and routing",
  "backup.sync.part.agents": "agent wiring",
  "backup.sync.part.profiles": "profiles",
  "backup.sync.part.library": "the Library",
  "backup.sync.part.features": "gateway features",

  "backup.syncDialog.edit": "Edit sync",
  "backup.syncDialog.on": "Turn on sync",
  "backup.syncDialog.description":
    "Sync between computers through a WebDAV directory or an S3-compatible bucket. The server keeps only a copy encrypted with the passphrase; every computer uses the same passphrase.",
  "backup.syncDialog.kind": "Sync method",
  "backup.syncDialog.s3": "S3-compatible storage",
  "backup.syncDialog.bucket": "Bucket",
  "backup.syncDialog.directory": "WebDAV directory",
  "backup.syncDialog.copyHint":
    "The copy is kept in harnesshub/harnesshub.harnesshub-backup inside it.",
  "backup.syncDialog.password": "Password",
  "backup.syncDialog.endpointPlaceholder":
    "Defaults to AWS's address for the region",
  "backup.syncDialog.region": "Region",
  "backup.syncDialog.addressing": "Addressing",
  "backup.syncDialog.auto": "Automatic",
  "backup.syncDialog.pathStyle": "Path-style (endpoint/bucket)",
  "backup.syncDialog.virtualHost": "Virtual-hosted (bucket.endpoint)",
  "backup.syncDialog.warning":
    "To sync unattended, the passphrase and the target's password are kept in this computer's secret store: anyone who can read this account's secrets can also open the copy on the server.",
  "backup.syncDialog.keys":
    "Sync the credentials' values (encrypted before upload)",
  "backup.syncDialog.agents": "Sync agent wiring",
  "backup.syncDialog.save": "Save and sync",
  "backup.syncDialog.done": "Sync is on, and the first sync has finished",
  "backup.syncDialog.firstFailed":
    "The settings are saved, but the first sync failed: {message}",
  "backup.syncDialog.needWebdav":
    "Enter the WebDAV directory's address (https://…)",
  "backup.syncDialog.needBucket":
    "Enter the bucket (s3://bucket or s3://bucket/prefix)",
  "backup.syncDialog.needAccessKey": "Enter the S3 access key ID",
  "backup.syncDialog.needPassphrase":
    "Turning sync on needs a passphrase, which encrypts the copy on the server",
};
