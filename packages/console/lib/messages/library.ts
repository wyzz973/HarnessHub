// SPDX-License-Identifier: MIT
/**
 * Messages of the Library page: instruction sets, MCP servers, skills and
 * their sync into agents (see ./types.ts).
 */
import type { Translation } from "./types";

export const zh = {
  "library.tab.instructions": "指令集",
  "library.tab.mcp": "MCP 服务",
  "library.tab.skills": "Skills",
  "library.tab.sync": "同步到 Agent",
  "library.lede":
    "指令集、MCP 服务与 Skills 保存在 HarnessHub 中，预览改动后写入本机各个 Agent 自己的位置与格式。",
  "library.syncIntro":
    "先预览每个 Agent 的文件改动，确认后按这份预览写入；预览之后文件又被改动的 Agent 什么都不写。HarnessHub 只拥有自己写入的部分，从 Library 删除的条目在同步时被取出。",
  "library.unassigned": "未分配",
  "library.agentsLegend": "去往的 Agent",
  "library.name": "名称",
  "library.idHint": "小写字母、数字与连字符",
  "library.save": "保存",
  "library.add": "添加",
  "library.delete": "删除",
  "library.none": "无",
  "library.size": "大小",
  "library.modified": "修改",
  "library.editItem": "编辑 {name}",
  "library.deleteItem": "删除 {name}",
  "library.listSeparator": "、",

  "library.instructions.new": "新建指令集",
  "library.instructions.edit": "编辑指令集 {id}",
  "library.instructions.description":
    "Markdown 文本写入每个 Agent 的用户级指令文件（如 CLAUDE.md、AGENTS.md）中一个带标记的区块，区块外的内容不动。一个 Agent 只有一套指令集。",
  "library.instructions.namePlaceholder": "团队约定",
  "library.instructions.noFile": "没有用户级指令文件",
  "library.instructions.takenBy": "已用于 {id}",
  "library.instructions.view": "编辑或预览",
  "library.instructions.editTab": "编辑",
  "library.instructions.previewTab": "预览",
  "library.instructions.markdown": "指令集 Markdown",
  "library.instructions.placeholder":
    "# 团队约定\n\n- 提交前运行测试\n- 回答使用中文",
  "library.instructions.empty": "没有内容",
  "library.instructions.saved": "已保存指令集 {id}；同步后写入 Agent",
  "library.instructions.column": "指令集",
  "library.instructions.emptyTitle": "还没有指令集",
  "library.instructions.emptyBody":
    "把团队约定、代码风格等写成一份 Markdown，同步到各个 Agent 的用户级指令文件。",
  "library.instructions.deleteTitle": "删除指令集 {id}",
  "library.instructions.deleteBody":
    "从 Library 删除；下一次同步时从各个 Agent 的文件中取出它的区块。",
  "library.instructions.deleted": "已删除指令集 {id}",

  "library.secretKind.env": "环境变量",
  "library.secretKind.file": "文件",
  "library.secretKind.value": "新值",
  "library.secretKind.keep": "已保存",
  "library.secret.source": "来源",
  "library.secret.value": "值",
  "library.secret.storedHidden": "已保存在秘密存储中，不显示",
  "library.secret.envPlaceholder": "变量名，例如 GITHUB_TOKEN",
  "library.secret.filePlaceholder": "绝对路径，例如 /home/me/.secrets/github",
  "library.secret.valuePlaceholder": "只发送一次，存入秘密存储",
  "library.secret.remove": "移除 {name}",
  "library.secret.thisRow": "这一行",
  "library.secret.noStored": "{field} {name} 没有已保存的值",
  "library.secret.needValue": "{field} {name}：填写值",
  "library.secret.needEnv": "{field} {name}：填写环境变量名",
  "library.secret.needFile": "{field} {name}：填写文件的绝对路径",
  "library.lineFormat": "{field}第 {line} 行应为 {format}",
  "library.secretRule.title": "不能引用 HarnessHub 自己的凭据",
  "library.secretRule.body":
    "MCP 服务的秘密不能是：HH_ 或 HARNESSHUB_ 开头的环境变量；数据目录与配置目录中的文件；任一 provider 凭据使用的变量、文件或秘密；Gateway Key、管理令牌或 provider Key 的值。请为这个服务另建一个专用的凭据。什么都没有保存。",

  "library.mcp.add": "添加 MCP 服务",
  "library.mcp.edit": "编辑 MCP 服务 {name}",
  "library.mcp.description":
    "Library 不保存秘密值：秘密以环境变量、文件或秘密存储的引用登记；Agent 支持变量引用时只写引用。",
  "library.mcp.saved": "已保存 MCP 服务 {name}；同步后写入 Agent",
  "library.mcp.transport": "传输",
  "library.mcp.stdio": "本地命令",
  "library.mcp.command": "命令",
  "library.mcp.args": "参数",
  "library.mcp.argsHint": "每行一个参数",
  "library.mcp.env": "环境变量",
  "library.mcp.envHint":
    "每行 NAME=value，只用于不是秘密的值；名称像 …_TOKEN、…_API_KEY 的会被拒绝，请改在下面登记为秘密。",
  "library.mcp.secretEnv": "秘密环境变量",
  "library.mcp.url": "地址",
  "library.mcp.headers": "请求头",
  "library.mcp.headersHint":
    "每行 Name: value，只用于不是秘密的值；Authorization、Cookie 等会被拒绝，请改在下面登记为秘密。",
  "library.mcp.secretHeaders": "秘密请求头",
  "library.mcp.noSse": "不支持 SSE",
  "library.mcp.moveEnv":
    "把 {name} 从环境变量移到秘密环境变量，选择它的来源（环境变量、文件或新值）。",
  "library.mcp.moveHeader":
    "把 {name} 从请求头移到秘密请求头，选择它的来源（环境变量、文件或新值）。",
  "library.mcp.columnServer": "服务",
  "library.mcp.columnTarget": "命令或地址",
  "library.mcp.columnSecrets": "秘密",
  "library.mcp.secretStore": "秘密存储",
  "library.mcp.store": "存储",
  "library.mcp.emptyTitle": "还没有 MCP 服务",
  "library.mcp.emptyBody":
    "登记一次本地命令或远程 MCP 服务，按各 Agent 自己的格式写入它们的配置。",
  "library.mcp.deleteTitle": "删除 MCP 服务 {name}",
  "library.mcp.deleteBody":
    "从 Library 删除，秘密存储中它的秘密一并删除；下一次同步时从各个 Agent 的配置中取出。",
  "library.mcp.deleted": "已删除 MCP 服务 {name}",

  "library.skill.add": "添加 Skill",
  "library.skill.description":
    "Skill 是一个含 SKILL.md 的目录（YAML front matter 的 name 等于目录名，并有 description），最多 500 个文件、20 MiB，不能含链接。同名 Skill 再次添加成为新版本。",
  "library.skill.source": "Skill 来源",
  "library.skill.uploadTab": "上传文件夹或 zip",
  "library.skill.pathTab": "守护进程上的目录",
  "library.skill.pickFolderLabel": "选择 Skill 文件夹",
  "library.skill.pickZipLabel": "选择 Skill 压缩包",
  "library.skill.pickFolder": "选择文件夹",
  "library.skill.pickZip": "选择 zip",
  "library.skill.reading": "正在读取文件…",
  "library.skill.fromFolder": "文件夹 {name}",
  "library.skill.fromZip": "压缩包 {name}",
  "library.skill.summary": "{from}：{count} 个文件，{size}",
  "library.skill.executableCount": "，{count} 个可执行",
  "library.skill.nameHint":
    "与 SKILL.md 中的 name 相同（小写字母、数字与连字符）。",
  "library.skill.executable": "可执行",
  "library.skill.more": "…… 另有 {count} 个",
  "library.skill.uploadHint":
    "文件在浏览器中读取，检查文件数与大小后上传；从文件夹上传时浏览器不提供可执行权限，需要可执行权限的脚本请用 zip 打包。",
  "library.skill.path": "目录的绝对路径",
  "library.skill.pathHint": "守护进程所在电脑上的路径。",
  "library.skill.upload": "上传",
  "library.skill.importAction": "导入",
  "library.skill.uploaded": "已上传 Skill {name}（{count} 个文件）",
  "library.skill.imported": "已导入 Skill {name}（{count} 个文件）",
  "library.skill.folderTooMany": "文件夹有 {count} 个文件，超过 {limit} 个",
  "library.skill.folderTooLarge": "文件夹共 {size}，超过 20 MiB",
  "library.skill.agentsTitle": "{name} 去往的 Agent",
  "library.skill.agentsUpdated": "已更新 {name} 的 Agent",
  "library.skill.files": "文件",
  "library.skill.fileCount": "{count} 个 · {size}",
  "library.skill.agentsLabel": "{name} 的 Agent",
  "library.skill.emptyTitle": "还没有 Skill",
  "library.skill.emptyBody":
    "导入符合 Agent Skills 规范的目录，链接到各个 Agent 的 Skills 目录。",
  "library.skill.deleteTitle": "删除 Skill {name}",
  "library.skill.deleteBody":
    "从 Library 删除；下一次同步时从各个 Agent 的 Skills 目录中移除 HarnessHub 放置的链接或副本。",
  "library.skill.deleted": "已删除 Skill {name}",
  "library.skill.noFiles": "没有文件",
  "library.skill.tooMany": "有 {count} 个文件，超过 {limit} 个",
  "library.skill.tooLarge": "共 {size}，超过 20 MiB",
  "library.skill.noSkillMd": "顶层没有 SKILL.md",

  "library.zip.notZip": "这不是 zip 文件",
  "library.zip.zip64": "不支持 ZIP64 格式的压缩包",
  "library.zip.corrupt": "压缩包已损坏",
  "library.zip.encrypted": "{path} 已加密，不能读取",
  "library.zip.link": "{path} 是链接；Skill 只能包含普通文件",
  "library.zip.tooMany": "压缩包有 {count} 个文件，超过 {limit} 个",
  "library.zip.tooLarge": "压缩包解开后有 {size}，超过 20 MiB",
  "library.zip.method": "{path} 使用了不支持的压缩方式（{method}）",
  "library.zip.size": "{path} 解压后的大小不符，压缩包可能已损坏",

  "library.kind.instructions": "指令集",
  "library.kind.mcp": "MCP 服务",
  "library.kind.skills": "Skill",
  "library.sync.action.write": "写入",
  "library.sync.action.restore": "还原",
  "library.sync.action.delete": "删除",
  "library.sync.action.unchanged": "不变",
  "library.sync.skillAction.place": "放置",
  "library.sync.skillAction.replace": "替换",
  "library.sync.skillAction.remove": "移除",
  "library.sync.skillAction.unchanged": "不变",
  "library.sync.changed": "有改动",
  "library.sync.unchanged": "没有改动",
  "library.sync.refused": "不写入 {kind} {name}：{reason}",
  "library.sync.file": "{action}{state} {path}",
  "library.sync.newFile": "（新文件）",
  "library.sync.skill": "{action} Skill {name} {path}",
  "library.sync.upToDate": "文件已经是 Library 的样子。",
  "library.sync.refusedCount": "{count} 个条目被拒绝，其余已写入",
  "library.sync.partial": "部分条目没有写入",
  "library.sync.done": "Library 已同步到 Agent",
  "library.sync.to": "同步到",
  "library.sync.notInstalled": "未安装",
  "library.sync.plaintext": "允许把秘密值写入不支持变量引用的 Agent 文件",
  "library.sync.copy": "复制 Skill，而不是建立链接",
  "library.sync.plaintextWarning":
    "支持环境变量引用的 Agent 仍然只写引用；其余 Agent 的文件会含有秘密的明文值（预览中显示为 <secret>）。",
  "library.sync.written":
    "已写入{agents}。正在运行的 Agent 重新启动后读到新的内容。",
  "library.sync.writtenNone":
    "已写入（没有改动）。正在运行的 Agent 重新启动后读到新的内容。",
  "library.sync.preview": "预览改动",
  "library.sync.previewAgain": "重新预览",
  "library.sync.write": "写入 Agent",
} as const;

export const en: Translation<typeof zh> = {
  "library.tab.instructions": "Instruction sets",
  "library.tab.mcp": "MCP servers",
  "library.tab.skills": "Skills",
  "library.tab.sync": "Sync to agents",
  "library.lede":
    "Instruction sets, MCP servers and skills are kept in HarnessHub and, after a preview of the changes, written into each agent on this computer in that agent's own place and format.",
  "library.syncIntro":
    "Preview each agent's file changes first; on confirmation exactly that preview is written, and an agent whose files changed after the preview gets nothing written. HarnessHub owns only what it wrote itself, and items deleted from the Library are taken out when you sync.",
  "library.unassigned": "Not assigned",
  "library.agentsLegend": "Agents it goes to",
  "library.name": "Name",
  "library.idHint": "Lowercase letters, digits and hyphens",
  "library.save": "Save",
  "library.add": "Add",
  "library.delete": "Delete",
  "library.none": "None",
  "library.size": "Size",
  "library.modified": "Modified",
  "library.editItem": "Edit {name}",
  "library.deleteItem": "Delete {name}",
  "library.listSeparator": ", ",

  "library.instructions.new": "New instruction set",
  "library.instructions.edit": "Edit instruction set {id}",
  "library.instructions.description":
    "The Markdown text is written into a marked block of each agent's user-level instruction file (such as CLAUDE.md or AGENTS.md); content outside the block stays as it is. An agent has only one instruction set.",
  "library.instructions.namePlaceholder": "Team conventions",
  "library.instructions.noFile": "No user-level instruction file",
  "library.instructions.takenBy": "Used by {id}",
  "library.instructions.view": "Edit or preview",
  "library.instructions.editTab": "Edit",
  "library.instructions.previewTab": "Preview",
  "library.instructions.markdown": "Instruction set Markdown",
  "library.instructions.placeholder":
    "# Team conventions\n\n- Run the tests before committing\n- Answer in Chinese",
  "library.instructions.empty": "No content",
  "library.instructions.saved":
    "Saved the instruction set {id}; it is written to the agents when you sync",
  "library.instructions.column": "Instruction set",
  "library.instructions.emptyTitle": "No instruction sets yet",
  "library.instructions.emptyBody":
    "Write team conventions, code style and the like as one Markdown text, and sync it into each agent's user-level instruction file.",
  "library.instructions.deleteTitle": "Delete instruction set {id}",
  "library.instructions.deleteBody":
    "It is deleted from the Library; the next sync takes its block out of each agent's file.",
  "library.instructions.deleted": "Deleted the instruction set {id}",

  "library.secretKind.env": "Environment variable",
  "library.secretKind.file": "File",
  "library.secretKind.value": "New value",
  "library.secretKind.keep": "Stored",
  "library.secret.source": "Source",
  "library.secret.value": "Value",
  "library.secret.storedHidden": "Kept in the secret store, not shown",
  "library.secret.envPlaceholder": "Variable name, such as GITHUB_TOKEN",
  "library.secret.filePlaceholder":
    "Absolute path, such as /home/me/.secrets/github",
  "library.secret.valuePlaceholder": "Sent once and kept in the secret store",
  "library.secret.remove": "Remove {name}",
  "library.secret.thisRow": "this row",
  "library.secret.noStored": "{field} {name} has no stored value",
  "library.secret.needValue": "{field} {name}: enter a value",
  "library.secret.needEnv":
    "{field} {name}: enter the environment variable's name",
  "library.secret.needFile": "{field} {name}: enter the file's absolute path",
  "library.lineFormat": "{field}, line {line}: it should be {format}",
  "library.secretRule.title":
    "HarnessHub's own credentials cannot be referenced",
  "library.secretRule.body":
    "An MCP server's secret cannot be: an environment variable starting with HH_ or HARNESSHUB_; a file in the data or configuration directory; a variable, file or secret that any provider credential uses; or the value of a Gateway Key, the admin token or a provider key. Create a separate credential for this server. Nothing was saved.",

  "library.mcp.add": "Add MCP server",
  "library.mcp.edit": "Edit MCP server {name}",
  "library.mcp.description":
    "The Library keeps no secret values: secrets are registered as references to an environment variable, a file or the secret store; an agent that supports variable references gets only the reference.",
  "library.mcp.saved":
    "Saved the MCP server {name}; it is written to the agents when you sync",
  "library.mcp.transport": "Transport",
  "library.mcp.stdio": "Local command",
  "library.mcp.command": "Command",
  "library.mcp.args": "Arguments",
  "library.mcp.argsHint": "One argument per line",
  "library.mcp.env": "Environment variables",
  "library.mcp.envHint":
    "One NAME=value per line, only for values that are not secret; names like …_TOKEN or …_API_KEY are refused, so register them as secrets below instead.",
  "library.mcp.secretEnv": "Secret environment variables",
  "library.mcp.url": "URL",
  "library.mcp.headers": "Headers",
  "library.mcp.headersHint":
    "One Name: value per line, only for values that are not secret; Authorization, Cookie and the like are refused, so register them as secrets below instead.",
  "library.mcp.secretHeaders": "Secret headers",
  "library.mcp.noSse": "No SSE support",
  "library.mcp.moveEnv":
    "Move {name} from the environment variables to the secret environment variables, and choose its source (environment variable, file or new value).",
  "library.mcp.moveHeader":
    "Move {name} from the headers to the secret headers, and choose its source (environment variable, file or new value).",
  "library.mcp.columnServer": "Server",
  "library.mcp.columnTarget": "Command or URL",
  "library.mcp.columnSecrets": "Secrets",
  "library.mcp.secretStore": "Secret store",
  "library.mcp.store": "store",
  "library.mcp.emptyTitle": "No MCP servers yet",
  "library.mcp.emptyBody":
    "Register a local command or a remote MCP server once; it is written into each agent's configuration in that agent's own format.",
  "library.mcp.deleteTitle": "Delete MCP server {name}",
  "library.mcp.deleteBody":
    "It is deleted from the Library, together with its secrets in the secret store; the next sync takes it out of each agent's configuration.",
  "library.mcp.deleted": "Deleted the MCP server {name}",

  "library.skill.add": "Add skill",
  "library.skill.description":
    "A skill is a directory with a SKILL.md (its YAML front matter has a name equal to the directory's name, and a description), with at most 500 files and 20 MiB and no links. Adding a skill with the same name again makes a new version.",
  "library.skill.source": "Skill source",
  "library.skill.uploadTab": "Upload a folder or zip",
  "library.skill.pathTab": "A directory on the daemon's computer",
  "library.skill.pickFolderLabel": "Choose the skill's folder",
  "library.skill.pickZipLabel": "Choose the skill's zip archive",
  "library.skill.pickFolder": "Choose a folder",
  "library.skill.pickZip": "Choose a zip",
  "library.skill.reading": "Reading the files…",
  "library.skill.fromFolder": "Folder {name}",
  "library.skill.fromZip": "Archive {name}",
  "library.skill.summary":
    "{from}: {count, plural, one {# file} other {# files}}, {size}",
  "library.skill.executableCount": ", {count} executable",
  "library.skill.nameHint":
    "The same as the name in SKILL.md (lowercase letters, digits and hyphens).",
  "library.skill.executable": "executable",
  "library.skill.more": "… and {count} more",
  "library.skill.uploadHint":
    "The files are read in the browser and uploaded after their number and size are checked. A browser gives no executable permissions for files in a folder, so pack scripts that need them in a zip.",
  "library.skill.path": "Absolute path of the directory",
  "library.skill.pathHint": "A path on the computer the daemon runs on.",
  "library.skill.upload": "Upload",
  "library.skill.importAction": "Import",
  "library.skill.uploaded":
    "Uploaded the skill {name} ({count, plural, one {# file} other {# files}})",
  "library.skill.imported":
    "Imported the skill {name} ({count, plural, one {# file} other {# files}})",
  "library.skill.folderTooMany":
    "The folder has {count, plural, one {# file} other {# files}}, more than {limit}",
  "library.skill.folderTooLarge":
    "The folder holds {size} in total, more than 20 MiB",
  "library.skill.agentsTitle": "Agents {name} goes to",
  "library.skill.agentsUpdated": "Updated the agents of {name}",
  "library.skill.files": "Files",
  "library.skill.fileCount":
    "{count, plural, one {# file} other {# files}} · {size}",
  "library.skill.agentsLabel": "Agents of {name}",
  "library.skill.emptyTitle": "No skills yet",
  "library.skill.emptyBody":
    "Import directories that follow the Agent Skills specification; they are linked into each agent's skills directory.",
  "library.skill.deleteTitle": "Delete skill {name}",
  "library.skill.deleteBody":
    "It is deleted from the Library; the next sync removes the links or copies that HarnessHub placed in each agent's skills directory.",
  "library.skill.deleted": "Deleted the skill {name}",
  "library.skill.noFiles": "There are no files",
  "library.skill.tooMany":
    "{count, plural, one {# file} other {# files}}, more than {limit}",
  "library.skill.tooLarge": "{size} in total, more than 20 MiB",
  "library.skill.noSkillMd": "There is no SKILL.md at the top level",

  "library.zip.notZip": "This is not a zip file",
  "library.zip.zip64": "Archives in the ZIP64 format are not supported",
  "library.zip.corrupt": "The archive is damaged",
  "library.zip.encrypted": "{path} is encrypted and cannot be read",
  "library.zip.link":
    "{path} is a link; a skill can contain only regular files",
  "library.zip.tooMany":
    "The archive has {count, plural, one {# file} other {# files}}, more than {limit}",
  "library.zip.tooLarge": "The archive unpacks to {size}, more than 20 MiB",
  "library.zip.method":
    "{path} uses an unsupported compression method ({method})",
  "library.zip.size":
    "{path} does not have its stated size after unpacking; the archive may be damaged",

  "library.kind.instructions": "instruction set",
  "library.kind.mcp": "MCP server",
  "library.kind.skills": "skill",
  "library.sync.action.write": "Write",
  "library.sync.action.restore": "Restore",
  "library.sync.action.delete": "Delete",
  "library.sync.action.unchanged": "Unchanged",
  "library.sync.skillAction.place": "Place",
  "library.sync.skillAction.replace": "Replace",
  "library.sync.skillAction.remove": "Remove",
  "library.sync.skillAction.unchanged": "Unchanged",
  "library.sync.changed": "Changes",
  "library.sync.unchanged": "No changes",
  "library.sync.refused": "Not written: {kind} {name}: {reason}",
  "library.sync.file": "{action}{state} {path}",
  "library.sync.newFile": " (new file)",
  "library.sync.skill": "{action} skill {name} {path}",
  "library.sync.upToDate": "The files already match the Library.",
  "library.sync.refusedCount":
    "{count, plural, one {# item was} other {# items were}} refused; the rest were written",
  "library.sync.partial": "Some items were not written",
  "library.sync.done": "The Library is synced to the agents",
  "library.sync.to": "Sync to",
  "library.sync.notInstalled": "Not installed",
  "library.sync.plaintext":
    "Allow writing secret values into the files of agents that cannot reference variables",
  "library.sync.copy": "Copy skills instead of linking them",
  "library.sync.plaintextWarning":
    "Agents that support environment variable references still get only the reference; the other agents' files will contain the secret values in plain text (shown as <secret> in the preview).",
  "library.sync.written":
    "Written to {agents}. Running agents read the new content after they restart.",
  "library.sync.writtenNone":
    "Written (no changes). Running agents read the new content after they restart.",
  "library.sync.preview": "Preview changes",
  "library.sync.previewAgain": "Preview again",
  "library.sync.write": "Write to agents",
};
