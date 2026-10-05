# Library Skills

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 单元：[library.test.ts](../../../packages/agents/test/library.test.ts) 覆盖链接的放置、更新与取出，副本与用户改动，同名目录；`library-validate.test.ts` 覆盖无效的 Skill 目录；集成：[library.test.ts](../../../tests/integration/library.test.ts) 经正式守护进程验证上传与目录导入同样校验、各平台都能保存的路径与 NFC 加大小写去重、同名只在 `replace` 时替换（API、SDK、`hh library add skill --replace`）；`tools/check-console-contracts.test.mjs` 覆盖浏览器端的 zip 读取与拒绝样例；macOS arm64 本机通过，另在 Chromium 中手工上传过 zip 与文件夹；Windows 的目录联接与复制未在 Windows 上验证；没有用真实 Agent 确认加载了 Skill |
| 对照 Magpie | 部分：链接到各 Agent、不能链接时复制为相同；接管 Agent 自己的同名 Skill 为部分（只有 `keep-own`）；市场与 GitHub 安装、项目级 Skills、从 Agent 导入未覆盖（[Library](../../magpie-parity.md#library)） |
| 权威文档 | [Library：条目](../../library.md#条目)、[归属与还原](../../library.md#归属与还原)、[备份与同步](../../library.md#备份与同步)、[API 参考：import_library_skill](../../api/reference.md#hh_api_v1_import_library_skill) |

## 用途

把符合 Agent Skills 规范的 Skill 目录导入一次，放进多个 Agent 各自的 Skills 目录。导入时就按规范和各平台的路径规则校验，不合格的不会进入 Library，也不会同步后被 Agent 静默跳过。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Library 页（`/library?tab=skills`）：上传浏览器中选择的文件夹或 zip（在浏览器中读取并解压），或导入守护进程所在电脑上的目录路径；改变去往的 Agent；删除；同名时确认后替换 |
| 命令行 | `hh library add skill <directory> [--agent A]... [--replace]`；`hh library list skills`；`hh library show skill <name>`；`hh library rm skill <name>`；放置用 `hh library sync [--copy]` |
| HTTP | `GET`、`POST /api/v1/library/skills`（`source` 为绝对路径，或以 `name`、`files`、`exec` 上传）；`GET`、`PATCH`（只改 `agents`）、`DELETE /api/v1/library/skills/{name}` |

## 已实现的能力

- 规范校验：`SKILL.md` 以 YAML front matter 开头，`name` 只含小写字母、数字与单个连字符并等于目录名，`description` 必填且最多 1024 个字符；不合格为 400 `LIBRARY_SKILL_INVALID`。
- 大小与内容：最多 500 个文件、20 MiB；目录中不能有链接；各文件的大小先 `lstat` 累计再读取内容，超限（包括稀疏或超过 2 GiB 的文件）不读入内存即拒绝，打开时不跟随链接、不等待管道。
- 跨平台路径：每段最多 255 字节、最多 16 层、整个路径最多 512 字节；不能含 `.`、`..`、Windows 禁用字符，不能是 `CON`、`NUL` 等设备名，不能以点或空格结尾；按 NFC 与大小写折叠后不能重复，也不能同时作为文件和目录。
- 上传：`files` 为 Skill 目录下的路径到 base64 内容，`exec` 列出可执行文件，请求体最大 30 MiB；只含普通文件，`.DS_Store` 与 `.git` 被忽略；写入时文件系统报 `EEXIST`、`ENAMETOOLONG`、`ENOTDIR`、`EISDIR` 同样是 400。控制台在浏览器中先检查 500 个文件、20 MiB 与顶层 `SKILL.md`，拒绝 zip 中的链接与加密条目，可执行权限只来自 zip。
- 内容寻址：每个版本存为 `<dataDir>/library/skills/<sha256>/<name>/`，存后不再修改；没有被 Library 或任何 Agent 引用的版本在下一次导入、删除或同步后回收。
- 同名：已有同名 Skill 时，导入或上传在校验之后、保存任何内容之前以 409 `LIBRARY_EXISTS` 拒绝；带 `replace: true` 才指向新版本。
- 放置：POSIX 上建立指向内容对象的符号链接；Windows 上先建目录联接，被拒绝时复制；`--copy`（API 的 `placement: copy`）强制复制，副本中带标记文件 `.harnesshub-skill` 记录版本。
- 归属：只有指向 Library 内容对象的链接、以及内容仍与标记版本一致的副本算 HarnessHub 的；Agent 中同名的其他目录被拒绝并报告（保留 Agent 自己的），副本被用户改过即归用户所有，之后只给出警告，不再替换或删除。
- 去往：9 个 Agent 各自的 Skills 目录，Kimi 用共享的 `~/.agents/skills`（Kimi 只读第一个存在的用户级目录）。
- 备份与同步：Skill 随备份与同步携带，超过 2 MiB 的文件不带。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [library/validate.ts](../../../packages/agents/src/library/validate.ts)（`readSkill`、`skillPathsProblem`、`SKILL_LIMITS`）、[library/store.ts](../../../packages/agents/src/library/store.ts)、[library/sync.ts](../../../packages/agents/src/library/sync.ts)（`SKILL_MARKER` 与放置）、[library-service.ts](../../../packages/daemon/src/library-service.ts)、[library-routes.ts](../../../packages/daemon/src/http/library-routes.ts)、[library-page.tsx](../../../packages/console/components/library-page.tsx) |
| 测试 | [packages/agents/test/library.test.ts](../../../packages/agents/test/library.test.ts)、[library-validate.test.ts](../../../packages/agents/test/library-validate.test.ts)、[library-store.test.ts](../../../packages/agents/test/library-store.test.ts)、[tests/integration/library.test.ts](../../../tests/integration/library.test.ts)、[check-console-contracts.test.mjs](../../../tools/check-console-contracts.test.mjs) |
| 决策 | 无专门的 ADR；设计见 [04 第 8 节](../../proposals/oss/04-agent-plane.md#8-library)；安全审查 D 组的修复见 [TODO.md](../../../TODO.md) |

## 已知限制与未验证

- Windows 的目录联接、联接被拒绝时的复制与设备名等规则只在 macOS 上以测试覆盖，未在 Windows 上运行。
- 与 Agent 自己的同名 Skill 冲突时只能保留 Agent 的（Magpie 的 `keep-own`），没有 `use-library` 接管；`--replace` 只替换 Library 自己的同名 Skill。
- Skills 只能来自本地目录或上传，没有市场、GitHub 安装与更新检查，也不能从 Agent 已有的 Skills 导入；没有项目级 Skills。
- 超过 2 MiB 的文件不随备份与同步携带，恢复到另一台机器的 Skill 因此可能缺文件。
- Qwen Code 的 Skills 目录在 [Library](../../library.md#各-agent-的位置) 中标为“待核”；没有用真实 Agent 确认加载了放置的 Skill。

## 优化候选

- **现状**：Agent 已有同名 Skill 时只能放弃放置。**方向**：增加 `use-library`：确认后把 Agent 自己的目录移入备份，再放置 Library 的版本，还原时移回。**依据**：对照表 “Taking over an agent's own same-name skill”（partial）。
- **现状**：Skill 只能从本地来，更新要手工重新导入。**方向**：支持从 GitHub 仓库安装并检查更新，导入仍走同样的校验与内容寻址。**依据**：对照表 “A market of MCP servers and skills, GitHub installs with update checks”（not covered）。
- **现状**：超过 2 MiB 的文件不进入备份与同步。**方向**：恢复与同步带入时明确列出缺少大文件的 Skill，或为 Skill 提供单独的大文件携带方式。**依据**：[Library：备份与同步](../../library.md#备份与同步)。
- **现状**：Windows 上的联接与复制路径没有证据。**方向**：在 Windows 上运行放置、更新与取出用例。**依据**：[Library 现状](../../library.md)“Windows 未验证”。
