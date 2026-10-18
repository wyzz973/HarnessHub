# 添加、更新与删除技能验收（2026-10-18）

依据 [ADR-045](../decisions/0045-unified-capability-management.md) 第 4 节和第 2 步余下部分，以及审批代理对这部分设计的裁决（同意，附六条条件，均已落实，见 ADR 的“审批代理对添加、更新、删除技能的裁决”）。用户要求：“要做到我们的 harnesshub 能够统一的配置和读取”。

## 改动

- **新模块**（`src/infrastructure/capabilities/`）：
  - `skill-tree.ts`：按 git 的规则计算技能文件夹的 tree id（排序、可执行位、链接、空文件夹）；npx skills 的排除规则；用 GitHub 树接口的列表计算文件夹的 tree id。
  - `github.ts`：解析用户输入的 GitHub 来源；只访问 GitHub 自己的四个主机，逐跳检查重定向；从压缩包链接的重定向取得提交号，下载那个提交的压缩包（不超过 64 MB）；流式读取压缩包，只接受普通文件与目录，路径不得越界，条目和解包大小有上限；匿名调用树接口，限额时说明恢复时间。
  - `skill-packages.ts`：在压缩包里找技能；按 npx skills 的规则命名文件夹；显式设置权限写出技能；暂存目录与启动时清扫；按 tree id 存放的快照；lock 的读取与逐字段定点修改；在各 Harness 自己的技能目录里找指向某个文件夹的链接。
  - `skill-changes.ts`：添加、检查更新、更新、删除、撤销的检查与执行，以及失败时的回滚。
- **改动的模块**：
  - `changes.ts`：接入以上动作；历史增加孤立的停用设置与快照统计；孤立的停用设置走开关检查清除。
  - `store.ts`：存储 v2，新增 `skill_sources`、`skill_undo`；降级脚本 `tools/capabilities-v2-to-v1.sql`。
  - `scan.ts`：HarnessHub 装的技能归属显示为 HarnessHub；两份 lock 都读；带插件清单的技能文件夹给出提示。
  - `switches.ts`：导出 Hermes 的 `external_dirs` 读法。
- **接口**：`skill-sources`、`skill-add`、`skill-updates`、`skill-update`、`skill-delete`、`orphans/:id/clear`，撤销沿用 `changes/:id/undo`，契约见 [provider-web-mvp](../contracts/provider-web-mvp.md)。服务器选项新增 `github`，测试注入假 GitHub，默认用平台的 `fetch`。
- **页面**：
  - “共享技能目录”卡片里有“从 GitHub 添加技能”和“检查更新”。
  - 技能详情里有“更新”“覆盖本地改动并更新”“删除”。
  - 确认框显示文件夹清单、逐个文件的改动、来源提交、lock 的差异、按归属分组的链接和留在原处的停用设置。
  - 页面顶部列出孤立的停用设置；历史里技能改动可以撤销，并显示快照数量与大小。

## 本机只读核对（实现前）

- 用户的 lock（`~/.agents/.skill-lock.json`）是 v3，61 个条目来自 13 个来源（github 60、well-known 1）。只取计数，没有打印内容。
- 按 git 规则用本地文件算出的 tree id 与 `skillFolderHash` 直接相同的有 54 个。不同的 7 个里，vercel-labs/agent-skills 的 3 个上游带 `metadata.json`，npx skills 复制时不拷贝它；另有 3 个 github 来源、1 个 well-known 来源。
- 直连 GitHub 可用（4317 的环境没有代理）：
  - 匿名树接口约 1 秒；
  - codeload 下载 841 KB 约 2.6 秒；
  - `github.com/<o>/<r>/archive/HEAD.tar.gz` 重定向到带提交号的 codeload 地址；
  - 树接口给出的文件夹 tree id 与 lock 记录的可以直接比较（例如 vercel-composition-patterns 相同，vercel-react-best-practices 有新版本）。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元 | `node --test dist/tests/unit/*.test.js` | 181 通过，0 失败 |
| 集成 | `node --test dist/tests/integration/*.test.js` | 398 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 39 通过，0 失败 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G064-W8～W11、G054-CA5 |

- **G064-W8**（单元）：
  - tree id 与真实 git 算出的值相同：完整文件夹 `1a63f47c…`、去掉排除项 `0754738a…`、SKILL.md 的 blob `f030aa0c…`；用 GitHub 树接口格式的列表算出的也相同。
  - 文件夹命名规则，以及只接受 GitHub 来源，有正反样例。
  - 压缩包：列出技能和可执行文件；嵌套技能归外层；`.git` 里的不算；含链接的技能被拒绝；越界路径、绝对路径、多个顶层目录、非压缩包都被拒绝。
  - 在 umask 077 下写出的技能仍是 0755/0644，不含 `metadata.json`。
  - lock 只改目标字段，其余字节不变；旧版本、新版本和非 lock 格式拒绝写入。
  - 快照放回后 tree id 相同，篡改的快照被拒绝；找链接时不碰 Claude 的 `synced` 与 `.trash`。
- **G064-W9**（集成，经正式入口，临时家目录，假 GitHub）：
  - 读取仓库，列出可添加、含链接被拒绝、同名冲突三种技能；读取与检查都不写入。
  - 在 umask 077 下添加：权限正确，不含 `metadata.json`，lock 字节不变；视图把它记为 HarnessHub 安装。
  - 上游更新后：检查更新显示有新版本；更新逐个列出文件；撤销放回旧版本。
  - 本地改过：先被阻止，带 overwrite 后说明覆盖了 1 个文件。
  - 只请求了 GitHub 自己的主机。
- **G064-W10**（集成）：
  - npx skills 装的技能按 lock 显示有新版本；按记录的 tree id 取旧版本，判断本地没改。
  - 更新后 lock 只改了两个值，其余字节不变，并先备份了 lock。
  - 删除连同 npx skills 建的链接和 lock 条目；孤立的停用设置被列出并清除。
  - 撤销删除：放回文件夹，按原写法重建链接，放回 lock 条目。
- **G064-W11**（集成）：
  - 跳到 `evil.example` 时返回 502，那台主机从未被请求；仓库内的文件夹可以缩小列表。
  - 检查之后有人放了同名文件夹，应用返回 409，没有写入。
  - 树接口额度用完时显示“无法检查”和恢复时间。
  - 降级脚本把存储改回 v1，其他记录保留。
- **G054-CA5**（浏览器）：
  - 先读取再选择，被拒绝的不能选；确认框显示文件夹、可执行文件数和来源。
  - 检查更新后标出有新版本；更新的确认框逐个列出文件和 lock 的差异。
  - 删除的确认框按归属分组列出链接，并列出留在原处的停用设置。
  - 孤立的停用设置可以清除；历史可以撤销；只发送确认过的检查。
- **合法的行为变更**：历史的回答多了 `orphans` 与 `snapshots`，所以更新了 G064-W3 里“被拒绝的写入不留记录”的断言，以及 G054-CA2～CA4 的模拟数据。

## 未验证与后续

- 4317 部署与真实环境的只读核对见下一节（部署后补充）。第一次真实的添加、更新或删除，由用户在页面上点击，或经审批后代为执行。
- 私有仓库、令牌、skills.sh 搜索、本地文件夹与开发链接、非 GitHub 来源不在本步。
- GitHub 匿名树接口每小时 60 次；来源多的用户频繁检查会用完额度，页面会显示恢复时间。
