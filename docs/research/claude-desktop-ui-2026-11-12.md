# Claude 桌面版「Code」标签页：结构、每种元素的数据、视觉数值

调研日期 2026-11-12。只读调研：没有改动 /Applications/Claude.app，没有运行其中任何代码，没有改动仓库文件。

## 0. 来源、方法、限制

来源标注一律写在每条结论后面：

- 【文档：链接】官方文档。`https://code.claude.com/docs/en/desktop`（全文 225k 字符，读了前 200k，末 25k 没读，含“Coming from the CLI”对照表）和 `.../desktop-quickstart`。WebFetch 是小模型摘要，不是原文，所以关键点尽量用前端包交叉核对。
- 【前端包：文件名＋位置】`/Applications/Claude.app/Contents/Resources/ion-dist.asar`（203 MB，5039 个文件，其中 JS 4436 个、CSS 27 个、i18n 28 个）。应用版本 4.23118.0（Info.plist）。`Resources/ion-dist/` 目录里只有 1.5 KB 的 index.html（旧版本的跳转页，自己写着“这个版本不加载它”）。asar 内文件名是内容哈希，如 `assets/v1/c96d752d0-Bliu2C2F.js`，每次构建都会变。
- 【宿主工具定义】本会话就运行在 Claude Code 桌面版里，宿主交给我的 `mcp__ccd_*` 工具（侧栏、面板、会话、PR、`wrap_up`、`update_plan`、`mark_chapter`、`start_session`）的描述，是官方对这些界面概念的文字规格。这是第四类来源，单独标出。
- 【推断】我自己的归纳，没有在包或文档里直接看到。

怎么读的包：自写 Node 脚本按 asar 头里的 offset/size 解出 JS、CSS、HTML、`i18n/en-US.json`（42,695 条界面文案，键是文案哈希），再用 postcss（仓库已装的只读依赖）解析 CSS，用 TypeScript 的 printer 只做格式化（不执行）读压缩 JS。从界面文案入手：先在 en-US.json 里找文案，再用“键 → 引用它的 JS 块”的索引定位组件。

包里的内部命名（对照用）：Code 会话界面叫 `epitaxy`（类 `.epitaxy-*`，根节点 `.epitaxy-root`）；外壳/侧栏叫 `dframe` / `df-*`；设计系统叫 CDS（变量 `--cds-*`，`data-cds="AssistantMessage"` 这类组件标记）；当前视觉版本叫 “fizzy lake”，`index.html` 的 `<html>` 上写着 `data-cds-fizzy-lake="color panels type" data-theme="claude" data-mode="system" data-density="comfortable"`，所以下面的取值以 fizzy-lake 为准，基础（偏暖灰）调色板只当回退。

限制：没有拿到真实窗口截图（需要用户批准 computer-use，我没有申请），所以“实际渲染”类结论都是从 CSS 和组件代码推出来的；凡是没能确认的，在第 4 节单列。

重要提示：包里的代码是第三方私有代码，报告只引用类名、变量名、数值、界面文案。解出来的文件在 scratchpad，不要拷进仓库。

---

## A. 界面由哪些区域组成

### A1. 整体布局

| 区域 | 内容 | 来源 |
|---|---|---|
| 应用级标签 | 侧栏顶部 Chat / Cowork / Code 三个标签（图标 Chats / Tasks / Code）；Code 标签上有状态点（运行中 / 等你输入 / 有未读） | 【文档：desktop-quickstart】【前端包：shared-21，`$T`、`iE` 里 “{tab}, working / awaiting your input / unread activity”】 |
| 侧栏 | 会话列表；顶部 “+ New”；Customize 入口（connectors、skills、plugins）。是浮在窗口里的圆角卡片：距窗口上/左/下各 8px，宽 288px（可拖动），圆角 8px | 【文档：desktop】【前端包：shared-styles-9rJLMXCT.css，`.dframe-root`、`.dframe-sidebar`】 |
| 会话标题栏 | 会话标题（点击改名）、标题旁的下拉菜单（含 Transcript view、Output style 等）、面板按钮 Terminal / Changes / Browser / Files；放不下的和没有按钮的面板（Background tasks、Plan）进 ⋮ 菜单；Hide/Show session rail 开关。高度变量 `--df-header-h` 默认 48px | 【文档：desktop】【前端包：同上 CSS】 |
| 对话区（transcript） | 居中一列。内容最大宽 `--transcript-measure`：默认 768px，设置里可选 960px / 1280px；两侧留白 `--chat-gutter` 32px（窄时 16px） | 【前端包：c6a992d55-BxgTbpOo.css，`[data-transcript-width]`、`.epitaxy-root`】 |
| 底部栈 | 从上到下：任务清单卡 / 下一步卡（同一块“turn rail”）、批准卡或提问卡（approval dock）、输入框（composer）。容器 `flex shrink-0 flex-col gap-xs px-sm pb-sm pt-xs` | 【前端包：c9bd7af9c-9J-JZBOI.js，组件 `FF`/`TF`】 |
| 会话详情栏（session rail） | 右侧一列卡片：Changes（改动 +N −N、PR、CI）、Environment（含 Remote Control 开关）、Context（卡头显示上下文百分比，点开按类别拆分）、后台工作。会话开始后且对话区够宽才出现 | 【文档：desktop】【前端包：cc43287c9-BRLjBjYR.js 的 “Session rail”“Show/Hide session rail”】 |
| 面板（pane） | chat、diff（Changes）、Browser、Terminal、file（Files）、Plan、Background tasks（tasks）、subagent、iOS Simulator。可拖标题移动、拖边缘缩放、Minimize（浮在聊天角落或会话详情栏下方）、弹出成独立窗口、分屏（Option/Alt+点击会话，或右键 Open in → Split view；分屏时当前焦点窗格正常显示，另一窗格变暗） | 【文档：desktop】【宿主工具定义：`ccd_view.show_pane`（diff/file/terminal/pr/tasks/plan/artifact/preview）、`ccd_window.open_session_in`（split/window/focus）】 |
| 输入框下一行（chin） | 环境选择、项目文件夹/仓库、Worktree 开关、权限模式、模型选择（含 Effort 小节）、用量环 | 【文档：desktop “row under the prompt box”】【前端包：CSS 里 `[data-cds=ChatComposerChin]`】 |

“当前布局”和“早期布局”两套：早期布局没有已保存的本地环境，Worktree 是分支名旁的复选框，状态栏有 CI 按钮。【文档：desktop “Check which layout you have”】。下面以当前布局为准。

### A2. 侧栏

**分组与排序**（同一套设置，菜单名 “Group and sort”；早期布局叫 Filter）：

- Group by：Date、Status（内部 `state`）、Folder（内部 `project`；在“分区布局”下是 Environment）、Environment、Custom（自定义组）、None。包里还有 `unread`、`type`、`folder` 几个内部值。【前端包：shared-21，函数 `aX` 与 `VY`】【宿主工具定义：`ccd_sidebar.set_view`：date | project | state | custom | none】
- Sort by：Last updated（`recency`，最近活动）、Date created（`created`）、Name（`alpha`，菜单里还有 “Sort A to Z”）。升降序可选（Ascending / Descending）。
- 状态过滤：active / archived / all；归档的在 “View all → Archived”。Status 分组时可按“最近活动天数”过滤：0（全部）/1/3/7/30。【宿主工具定义：`set_view.last_activity`】
- 其它开关：Show empty groups、Show PR status、Side chats、Collapse all / Expand all、“Show {n} more in {bucket}”（每个桶默认只显示若干行，可展开）。【前端包：shared-21、shared-140 文案】

**分区**：内置三个——Pinned（置顶，置顶的会话不会被自动归档）、Routines（定时任务，界面里也叫 Scheduled）、Sessions；加上用户自建的自定义组（`manual` 类，可新建、改名、删除、上下移动、“Move to group”，没分组的叫 Ungrouped；从环境生成的组不能改名/删除）。每个分区有 `group_by / sort_by / ascending / collapsed / shown` 属性。【宿主工具定义：`ccd_sidebar.list_sections`】

**一行显示什么**（按代码还原）：

1. 前导槽（24px 宽，图标 16px）：状态点或图标。状态点是 6×6px 圆点，`data-kind` 有五种：`running`（灰，`--cds-text-muted`，1.2s 明暗闪烁）、`awaiting`（黄，`--cds-fill-warning`，等你处理）、`ready`（蓝，`--cds-fill-accent`，未读回复）、`error`（红，`--cds-fill-danger`）、`clay`（品牌赭色 #d97757，3s 呼吸，Code 标签上用）。另有“三点”加载（3 个 2px 点，1.8s 依次亮）。【前端包：shared-styles CSS `.status-dot`、`.dframe-dot`；shared-21 的 `XA = {unread: "ready", working: "running", blocked: "awaiting", error: "error"}`】
2. 标题（13px，单行省略）。没标题显示 “Untitled”。
3. 第二行（“meta line”，12px/行高 16px，次要色，尾部 12px 渐隐遮罩）：`[状态词] [状态句] [place]`。状态词来自 `idle / unread(显示 Done) / working(Working) / blocked(Waiting) / error(Error)`；状态句：进行中取 `taskSummary`，回合结束后依次取 `postTurnSummary.status_detail → recent_action → description`，都没有时取 `lastUserMessage`；place 是文件夹/分支/主机（宽度封顶 `min(14ch, 40cqi)`，带图标：local=Folder、cloud=Cloud、ssh=CommandLine、bridge=Laptop）。【前端包：shared-20-B0ubXkM0.js，函数 `sj`（状态句）、`pj`（meta line）、`ZA`（place 图标）】
4. PR 行（开启 Show PR status 时）：PR 号、标题、仓库、状态词（Ready/Draft/Approved/Changes requested/Conflict/Queued/Merged/Closed；进行中的 PR 且 CI 没过时改显示 “Checks running / Checks failed”）、`+N −N`。【前端包：shared-20，`ej`、`tj`、`_j`、`JA`】
5. 行尾：悬停出现 ⋮ 菜单（Archive、Pin/Unpin、Mark as read/unread、Mark as completed、Open in split view / new window、Copy session ID、Move to group…）；未读/需要处理时尾标 `df-tail-mark`（20px）。【前端包：shared-140、shared-21】
6. 行高：普通行 26px，带第二行的行为“described row”（上下各多约 4px）。行字号 13px，分组标题 12px。

**状态语义**：蓝点＝有未读回复；黄点＝等你批准/回答（宿主工具里叫 “needs input”）；红点＝失败；“Mark as completed”只是确认掉黄点/红点，之后再需要处理会自己回来。状态词的完整文案：Awaiting input（等批准）、Awaiting answer（等回答）、Running、Using the browser、Unread response、Idle、Done。分组标题上，只要组里有会话在等你，就带提示 “A session in this group is waiting on you”。【前端包：cbd6c85c8-DZEh9hxp.js，`Mz`；shared-140】【宿主工具定义：`ccd_sidebar.mark_completed / set_unread / set_pinned`】

**嵌套子会话**：Claude 用 `start_session` 开的会话（Start 建议）显示在发起会话的下面，用一条 1px 的折线（`.df-family`，左边框＋下边框，圆角 6px，宽 10px）连到父行。折叠后父行显示隐藏子会话的汇总：“{n} nested sessions”、“{n} failed / unread / working”、“{n} nested session needs input”；可 “Hide/Show nested sessions”，可 “Stop {n} nested sessions”。【文档：desktop】【前端包：shared-20，`EA` 文案、shared-styles CSS `.df-family`】【宿主工具定义：`get_session` 的 `parentSessionId`、`detached`、`startedBy`】

### A3. 对话时间线逐元素

先说总体模型（决定协议的形状）：一个“回合（turn）”里有用户消息和助手条目；助手条目是一串 `items`，种类有 `text`、`narration_summary`、`thinking`、`tools`（一组工具调用）、`task_event`、`event`（CI/GitHub/定时触发等）、`peer`、`error`、`turn_error`；回合有 `turnEnded`、`turnKey`。【前端包：c96d752d0-Bliu2C2F.js，函数 `Hpt`、`e5`】

| 元素 | 样子 | 默认展开/折叠 | 来源 |
|---|---|---|---|
| 用户消息 | 右对齐气泡，`--cds-bg-neutral`（中性色 5% 透明度）底，圆角 10px，内边距 横12px 竖8px，最大宽为对话列的 85%；入场动画 0.45s（缩放 .92＋上移 6px，过冲缓动）。悬停出现操作：复制（Copy message）、编辑重试（Edit and retry）、Rewind to here、Fork from here、时间戳（`UserMessage.Actions/CopyAction/EditAction/Timestamp`） | 展开；很长的消息大概率有 “Show more / Load the rest of this message”（只见文案，【推断】） | 【前端包：c6a992d55 CSS `[data-cds=UserMessage]`；c96d752d0 文案】 |
| 助手文字 | 无气泡的 Markdown，文字左缩进 4px（`--cds-assistant-message-text-inset`），字体见 B 节；流式渲染有 `[data-alluvium]`、`.epitaxy-fade-root` 两个钩子，另有逐词淡入样式 `.fade-in-text__word`（0.4s ease-out，是否用于 Code 流式文字未确认，【推断】） | 展开 | 【前端包：c19e90103-DLr2g1Qi.css `.epitaxy-markdown`；c4b7ce3b5-BMzG8Bd0.css；c6a992d55 CSS `[data-cds=AssistantMessage]`】 |
| 思考 | Normal 视图里不显示；Thinking / Verbose 视图里显示思考摘要；转录配置里有 `thinkingJoinsGroup: true`，我理解为思考并入相邻的工具组（【推断】）。运行中文案依次演变：Thinking… → Thinking some more… / Thinking more… → Still thinking… → Almost done thinking…；结束后 “Thought for 12s / 1m 5s / 2h” | Normal 隐藏；Thinking、Verbose 显示 | 【文档：desktop “Transcript view”】【前端包：c96d752d0 文案与配置、c05b96c7f 的 “Thought for {minutes}m {seconds}s”】 |
| **工具调用（单行）** | 一行文字：`动词 · 对象`，例如 “Ran · npm test”“Read · foo.ts”。动词用次要色（失败时红色），对象是单行省略的次要色文字（命令、路径、模式、域名用等宽“代码”样式），悬停变主色并出现展开箭头（▸，展开转 90°）；运行中显示实时计时（等宽数字）。**没有看到按工具种类区分的图标**，区分靠动词和对象样式 | 单个工具行默认折叠，点开看详情 | 【前端包：c96d752d0 约 5851 行；c52b02f3f-CGuaVtkr.js 的工具→标签映射】 |
| **连续工具调用的分组摘要** | 一串连续的工具调用（含思考）折成一行摘要：首字母大写的“动词＋数量名词”，用逗号连接，例如 “Ran 3 commands, read 2 files, edited a file”。规则见 A3.1 | Normal 视图折叠成一行；点击展开成逐步列表；Verbose 视图全部展开 | 【文档：desktop “Normal: tool calls collapsed into summaries”】【前端包：c24951e9f-m_JtFnxa.js】 |
| 命令输出（展开后） | 终端式代码块（`.epitaxy-terminal-view`，等宽 12px/17px，带 “First {n} lines”/Show more 截断，Output 标题，退出码 “{label} · exit {code}”）；失败显示 “Command failed” | 折叠在工具行里 | 【前端包：cf6989767（`.epitaxy-terminal-view`）；c96d752d0 文案】 |
| 文件改动（diff） | Write/Edit 的详情是 diff 卡（`FileDiff` / `.epitaxy-diff`，用 Pierre diffs 渲染，等宽 12px，新增色/删除色见 B 节）；还有“提议的改动”：权限模式为 Manual 时显示 “Proposed a change to …”，等批准 | 折叠；回合末有汇总卡（见下） | 【前端包：c6a992d55 CSS、pierreWorkerWithBracketPairs-*.js；c52b02f3f `al()`】 |
| 读文件 | Read 的详情是文件内容预览（`kind: "file"`） | 折叠 | 【前端包：c52b02f3f 里 `Xc()`】 |
| 回合末“改动汇总卡” | 一行：`[±图标] Edited 3 files  +12 −1  [▸]  [Undo]`，下面列出前几个文件（文件名＋各自 +N −N，新增色/删除色）；在有侧面板的布局下，文件列表后还有一行 “See all” 或 “Total”（合计 +N −N，细节未逐项核对）。点击卡头打开 Changes 面板；Undo 的悬停提示是 “Ask Claude to undo this turn's file changes”。标题措辞按内容选：Created a file / Created N files、Changed N files、Edited N files | 展开 | 【前端包：c96d752d0 约 1319492 字节处；文案 `NEQt2+m0IJ`、`I3E+BECGKi`、`EQZTQdYSJR`】 |
| **任务清单（计划）** | 不在时间线里，**固定在底部栈、输入框上方**。卡片 `p-4`（16px）。每步一行：进行中的那一步在运行时显示转圈（`spin 1.6s linear infinite`），完成的步骤变灰并用“对勾描画”动画（0.18s，clip-path 从左到右），未开始的是普通文字。最多显示 12 步，超出的折成 “{n} earlier steps” 和 “{n} more to go”（11px 次要色）。某一步关联了子会话时，在该步下显示子会话名和 “{n} running tasks”。过期的计划标 “Plan from before your last message”。“下一步”卡里有按钮或文字时，清单卡直接被隐藏（CSS `:has(+[data-turn-next] …)`）；清单被清空时用 0.2s 收起动画（`epitaxy-plan-exit`） | 工作中展开；回合结束后让位给下一步卡 | 【前端包：c9bd7af9c，组件 `TF`/`OF`、常量 `CF = 12`；c6a992d55 CSS `.epitaxy-plan-exit`、`epitaxy-check-draw`】 |
| **“下一步”框** | 回合结束后出现在同一块底部栈，`p-4` 内边距。内容：一段小结（recap）、可选的一个问题、一排按钮（chip）。按钮横排，`gap-sm`，能放几个放几个，放不下的折进 “+N” 弹出菜单（`Show {count} more`）；主按钮（primary）是 `primaryKey` 指定的那个模型给出的回复按钮（`source: model`、`kind: send`），输入框没有草稿时可用 Cmd+Enter 触发，其余是次按钮（secondary）。按钮分两类：回复（点了把文字发出，文字太长时先装进输入框）和应用动作（commit、create_pr、merge、fix_ci、address_comments、resolve_conflicts、verify、archive、new_session）。`blocked: true` 表示会话在等用户，侧栏上显示等待状态 | 回合结束后出现，用户发下一条消息后收起 | 【宿主工具定义：`mcp__ccd_turn__wrap_up`（recap≤约300字、ask≤100字、actions 1–2 个、blocked）】【前端包：c227f4d5e-DgLfLa60.js，组件 `z3`/`r6`；c9bd7af9c `TF` 的 `[data-turn-next]`、`[data-turn-dismiss]`】 |
| 离开后的“Recap”卡 | 你回到会话时的一张小卡：卡头 “Recap”（11px 中粗、次要色）＋右上 × 关闭；正文 12px 斜体次要色。圆角 10px、1px 边框、`surface-1` 底。每个会话只显示一次（关闭状态存 localStorage `epitaxy.awayRecapDismissed:<id>`） | 展开，可关闭 | 【前端包：c96d752d0，`Qft`/`k8`；`RHe` 里 `away_summary`】 |
| 章节分隔线与目录 | 助手用 `mark_chapter(title, summary?)` 在时间线里插一条分隔线，窗口里有“浮动目录”可跳转；用户也能把某条消息 “Pin as chapter”（可 Unpin，章节标题可改）。标题是 40 字内的名词短语；摘要是目录项悬停提示 | 分隔线始终可见；目录是浮层 | 【宿主工具定义：`mcp__ccd_session__mark_chapter`】【前端包：c96d752d0 与 cf74bc599 的 “Session chapters”“Pin as chapter”“Chapter title”】 |
| 文件卡片/文件引用 | 文本里的文件和链接是行内“芯片”（`.epitaxy-link-chip`、`.epitaxy-code-chip`，等宽），点击在 Files 面板打开；工具行有 “Opened file”；回合末汇总卡里的每个文件是可点击行 | 内联 | 【前端包：c19e90103 CSS；c52b02f3f】 |
| 提案/新会话卡片 | 官方叫 Suggested task / 新会话提案：标题（≤60 字）＋按钮 **Start**、**Do it here**、**Options**（含 “Always start a new session / Always do it here”）、**Start all**；被忽略的显示 “Dismiss suggestion”，状态词 “Still suggested / No longer suggested / Kept in this session”。`start_session` 的三种发起方式（user_asked 直接开、offer 弹卡等用户答、own_initiative 放卡片等用户点）决定卡片是否阻塞 | 展开（等待用户） | 【文档：desktop “Suggested task card”】【宿主工具定义：`mcp__ccd_session__start_session`】【前端包：c96d752d0 文案】 |
| 内联小组件 | 连接器（MCP）返回的 HTML 小组件直接渲染在时间线里；失败时 “Couldn't load this widget, so its result is shown as text.”；可 “Hide/Show widgets from this connector” | 展开 | 【前端包：c96d752d0 文案 “Widget from {server}”“Rendering widget”】 |
| 权限批准提示 | 吸附在输入框上方的“批准卡”（`.epitaxy-approval-card`，最小高 168px，带提示时 234px；窄屏最大高 `max(60vh,16rem)`）。句式固定：**Allow Claude to <粗体动作> <代码样式对象>?**，例如 “Allow Claude to run `npm test`?”“Allow Claude to edit `foo.ts`?”。按钮：Allow once、Always allow（会话内有效，旁边说明“Always allow lasts for this session and covers: …”，带 “Don't ask again for this tool”）、Reject / Deny；Manual 模式下编辑类批准显示 diff；“More accept options”。结果留在时间线：Not approved / You declined / Denied / Blocked by permissions / Blocked by auto mode。计划批准：“Claude wants to leave plan mode”，按钮 Allow edits / Allow and switch to Auto，另有 “Plan feedback”（“What should change? (optional)”）。外部网站动作：Allow once / Always allow / Deny。App 权限：Allow for this session / Deny，并标注 View only / Click only / Full control | 出现时占据底部；决定后收起 | 【文档：desktop】【前端包：cc32965c2-BWcTYd9j.js 文案；c6a992d55 CSS `.epitaxy-approval-card`】 |
| 向用户提问 | `AskUserQuestion`：多个问题、每题有 header 和若干选项，渲染成同样吸附在输入框上方的卡（`[data-cds=AskUserQuestion]`）；等待期间侧栏状态词是 Awaiting answer；时间线里的结果行是 “Asked a question”（1 个问题时 meta 显示题目的 header，多个时显示 “{n} questions”）；没回答是 Not answered；输入框提示 “Answer Claude's request first” | 出现时占据底部 | 【前端包：c52b02f3f `case "AskUserQuestion"`；c96d752d0 文案】【文档：desktop 本身没有写这个对话框】 |
| 错误、通知、被打断 | 回合级：Turn failed、Reached maximum number of turns、Stopped（被中断，“Stopping…” 是中间态）、Claude couldn't process that message、Rate limited / Service is busy（带重试提示和 “Failed after {n} attempts. Send a new message to retry.”）。消息级：Sending…、Queued. Claude will read this after the current turn.、Not delivered · {时间}（带 Retry / Discard）、A hook stopped a message… 。通知（notice）是一行淡色文字：Recap、All background agents stopped、memory saved、instruction file 过大警告；还有系统事件行：Context cleared、Rewound here、Forked here、Compacting…、Entered/Left worktree、Scheduled check-in、Received a CI/GitHub event | 一行文字，不折叠 | 【前端包：c96d752d0 文案；`RHe` 的 notice 种类】 |
| 回合元信息 | 时间线里很少：思考耗时（Thought for …）、子代理/后台任务的耗时和状态（完成后显示 ✓＋耗时，卡住时 “Stalled {duration}”，失败时 Failed）、运行中工具的实时计时、悬停消息时的时间戳（“You · {when}”）。用量/模型/费用**不**逐回合显示，在会话详情栏的 Context 卡（百分比＋分类拆分，含 Input/Output/Cache read/Cache write token）、输入框的用量环和 “{tokens} until auto-compact” 提示里 | — | 【前端包：c96d752d0、c227f4d5e 文案】【文档：desktop】 |

#### A3.1 工具调用的分组与措辞规则（从代码还原）

1. **哪些算一组**：一个助手回合里，两段文字之间连续出现的工具调用（`tools` 条目）折成一个“状态组”（`data-cds=TurnStatus`，每一步是 `TurnStatusStep`），思考并入其中；代码里还有 `promotions / leadersOfRun / trailersOfRun / nonStepToolIds` 这套机制，把个别工具（例如带 `groupId` 的子代理任务卡 `code.spawn_tasks`）提到组外单独成卡。具体哪些工具被提升我没有逐个核对。【前端包：c96d752d0 `Rpt`、`Hpt`、`I8`；【推断】】
2. **摘要一行怎么拼**：先把组内调用按“类别”分桶，类别按第一次出现的顺序排；每个桶给出（小写过去式动词＋带数量的名词），整行首字母大写，用 “, ” 连接。类别→词：

| 类别 | 摘要里的词 |
|---|---|
| read | read a file / read N files |
| view | viewed a file / N files |
| write | created a file / N files |
| edit | edited a file / N files（notebook 是 a notebook / N notebooks） |
| staged_edit（待批准的改动） | proposed a change to a file / proposed changes to N files |
| delete_file | deleted a file / N files |
| bash | ran a command / N commands |
| code | ran code |
| grep | searched code |
| glob | searched for files |
| web（WebSearch） | searched the web / the web N times |
| web_fetch | fetched a page / N pages |
| task（子代理） | ran an agent / N agents |
| todo、plan | updated todos |
| exit_plan_mode | proposed a plan |
| worktree | moved to a worktree / left the worktree |
| started_session | started a session / N sessions |
| peer_message | messaged another session / N other sessions |
| 其它（含 MCP） | used a tool / N tools；有显示名时 “{label} N times” |

3. **数的是什么**：每个类别里数“不同的目标”（不同文件路径、不同命令键），不是调用次数：同一个文件读了三次，read 桶里仍是 1 个文件。
4. **合并成一句**：如果整组所有文件类调用只涉及同一个文件，几个文件类动词合成一句 “Read and edited foo.ts”（用连词列表），末尾文件名可点击打开；否则各类别分开写（“read a file, edited 2 files”）。
5. **类别太多时截断**：最多先列 3 个类别；总共 5 个及以上类别时，列前 3 个，其余折成 “and N more actions”（N 是被折起的各桶数量之和）；恰好 4 个类别时全部列出。
6. **结果标注**：桶内有失败/被拦/被中断的，在该桶后面括号标注：“ran 3 commands (1 failed)”、“(1 blocked)”、“(2 stopped)”；一个桶全部失败，整段染成错误色。被中断或被拒绝算 stopped，策略拒绝算 blocked，待批准算 held，error 算 failed。
7. **相同的“说法”合并**：描述相同的非分类调用（例如同一个 MCP 工具）会写成 “{说法} N times”。
8. **运行中和完成后的切换**：每一步有“运行中标签”（现在分词/进行时，如 Running a command、Reading、Editing {file}…）和“完成标签”（过去式，如 Ran、Read、Edited），按 `status` 切换：running 或被打断→运行中标签；error→失败标签（Failed to read / Failed to write / Failed to edit / Failed to search / Failed to fetch…）；其余→完成标签。运行中标签至少停留 650ms 再变形成完成标签（避免闪烁）；运行中的文字有高光扫过的 shimmer（见 B6）。
9. **单行格式**：`动词 + 对象`，对象来源：Bash 优先用 `description`，没有则用命令文本（等宽），再没有则 “a command”；Read/Write/Edit 用文件名（经 `Q()` 处理，应是路径尾部，【推断】）；Grep/Glob 用 pattern；WebFetch 用 URL 的主机；WebSearch 用 query；Task/Agent 用 description 或 subagent_type；Skill 用 “/技能名”。

#### A3.2 单个工具名→行标签与详情类型（C12 的详细版）

详情类型 `kind`：`bash`（Bash/BashTool/PowerShell）、`file`（Read）、`diff`（Write/Edit/MultiEdit/NotebookEdit）、`todos`（TodoWrite、Task*）、`plan`（ExitPlanMode）、`question`（AskUserQuestion）、`peerMessage`（SendMessage）、`agent_status`、其余 `text`。【前端包：c52b02f3f-CGuaVtkr.js，`Xc()`】

| 原生工具 | 完成 / 进行中 / 失败 | 对象（meta） |
|---|---|---|
| Bash / PowerShell | Ran / Running / （Failed 变体） | description，否则命令文本（等宽） |
| Read | Read / Reading / Failed to read | 文件名 |
| Write | Created（已存在则 Updated）/ Creating（Updating）/ Failed to write | 文件名 |
| Edit / MultiEdit / NotebookEdit | Edited / Editing / Failed to edit；待批准时 “Proposed a change to” | 文件名；Notebook 插入/删除 cell 是 “Added a cell to / Deleted a cell from” |
| Grep | Searched / Searching / Failed to search | pattern（等宽） |
| Glob | Searched files / Searching files | pattern |
| LS | Listed / Listing | 路径 |
| WebFetch | Fetched / Fetching / Failed to fetch | URL 主机 |
| WebSearch | Searched web / Searching web | query |
| Task / Agent | Ran agent / Running agent / Failed to run agent | description（或 subagent_type） |
| Skill | Ran skill / Running skill | /技能名 |
| TodoWrite | Updated todos / Updating todos（清空是 Cleared todos） | — |
| TaskCreate/Update/Get/List/Stop | Added task / Updated task（按状态变体）/ Read task / Listed N tasks / Stopped task | 任务标题或 #id |
| EnterPlanMode / ExitPlanMode | Started planning / Making a plan；Proposed plan / Finished planning | 计划标题 |
| EnterWorktree / ExitWorktree | Created or Entered a worktree / Left the worktree | worktree 名 |
| AskUserQuestion | Asked / Asking（组内 “Asked a question”） | “{n} questions” 或题目 header |
| SendMessage | 给另一个会话发消息 | 收件会话名 |
| ScheduleWakeup / CronCreate / Monitor / Workflow | Scheduled check-in、Started loop、Monitor、Workflow 各自的词 | 原因/描述 |
| ToolSearch | Loaded tools / Loading tools（找不到是 Found no tools） | 工具名列表 |
| **MCP 工具（未知的）** | `Used {服务器显示名}: {工具名，下划线换空格}` / `Using …` / `Failed to use …`；分组时降成 “Used {服务器名}” | 工具返回里能提取的文件名等 |
| 宿主自带的 `mcp__ccd_*` | 各有专用词：Renamed session、Started session、Merged base branch、Updated pinned sessions、Moved sessions、Opened diff 等 | — |

---

### A4. 输入框（composer）

- 占位符：新会话 “Describe a task or ask a question”；进行中的会话 “Reply in this session…”；侧聊 “Ask a quick question”。【前端包：cc43287c9、c9bd7af9c】
- 控件：
  - “+” 菜单：Add files or photos、Add folder（本地/SSH）、Slash commands、Add connectors、Add plugins。拖放和粘贴支持图片、PDF 和其它文件。`/` 打开斜杠命令；`@` 引文件；`!` 进入 shell 模式（“Bash mode. Press Escape to return to chat.”，PowerShell 同理）。
  - 输入框下一行（chin）：环境选择（Local / Cloud / SSH / WSL，底部 New environment）、项目文件夹或仓库选择、Worktree 开关、**权限模式**（Manual、Accept edits、Plan、Auto、Bypass permissions；快捷键 Cmd+Shift+M；Auto 只在可用时出现）、**模型选择**（含 Effort 小节，Cmd+Shift+I / Cmd+Shift+E）、用量环（点击看计划用量）。
  - 空输入框里灰色的建议提示，Tab/→ 接受（设置 “Prompt suggestions”）。
- **运行中的变化**：出现停止按钮（Esc 同效，即时打断）；Enter 发出去的纠正会先排队，Claude 做完当前动作后读到（“Queued. Claude will read this after the current turn.”）；“{sendKey} to send, {queueKey} to queue for later”——Enter 发送，Cmd+Enter 排到后面；排队消息在输入框上方的队列卡里显示（“{n} queued”，可 “Remove queued message”、可重排 `reorderQueued`）；发送接口的优先级字段出现过 `now`、`next`、`later` 三个值（具体对应哪个键位没有核对）；用量限制时消息被“held”，“Send anyway”立即发。【文档：desktop、desktop-quickstart “Interrupt and steer”】【前端包：c227f4d5e 文案；c9bd7af9c 里 `priority` 参数】
- 其它：Fork with this prompt / Send in a forked session / Send and stay here（“More send options”）；上箭头翻历史（“History {i}/{n}”，Ctrl+R 搜索历史）；Dictate；上下文接近上限时 “{tokens} until auto-compact / Auto-compacts soon”。

### A5. 面板（入口与样子）

| 面板 | 入口 | 内容 | 来源 |
|---|---|---|---|
| Changes（diff） | 会话详情栏 Changes 卡里的 `+12 −1`、标题栏 Changes 按钮、Cmd+Shift+D | 按文件的 diff；悬停行号出现 “+” 可对某行评论，Cmd+Enter 一次提交所有评论，Claude 回一份新 diff；`/code-review` 的发现以 “Code review” 卡按文件分组，按钮 “Walk through in diff”（逐条走，Fix this one 或忽略）、“Apply fixes” | 【文档】 |
| Files | 标题栏 Files；点击对话里的文件路径 | 本地会话可编辑（Auto save 默认开，关掉后有 Save/Cancel；磁盘变了给 Override/Discard），云端/SSH/WSL 只读；右键有 Attach as context、Open in（VS Code/Cursor/Zed…）、Show in Finder、Copy path | 【文档】 |
| Terminal | 标题栏 Terminal、Ctrl+` | 在会话工作目录里的终端，可开多个标签 | 【文档】 |
| Browser（preview） | 标题栏 Browser、Cmd+Shift+B | 内置浏览器，开发服务器预览，Cmd+Shift+S 选元素；外部网站首次动作要批准 | 【文档】 |
| Background tasks（tasks） | ⋮ 菜单（会话有后台工作后出现） | 子代理、后台 shell、动态 workflow 列表；点条目看输出或停止 | 【文档】 |
| Plan | ⋮ 菜单 | 计划文档 | 【文档】【宿主工具定义：`show_pane("plan")`】 |
| PR | 会话详情栏 Changes 卡 | PR 号、CI 检查计数和失败项、评审决定、可合并性；⋮ 菜单里 **Auto-fix**（失败的检查、合并冲突、新评审评论都唤醒 Claude 去修）和 **Merge when ready**（GitHub auto-merge，默认 squash；SSH/WSL 里不可用）；还有 Create PR / Push / Commit / Merge / Convert to draft / Mark ready | 【文档】【宿主工具定义：`ccd_pr.get_status / set_monitor / set_auto_merge`】【前端包：c96d752d0 文案 “CI: checks failing”“Auto-fix CI & address comments”“{n} commits to push · {m} behind {base}”】 |
| Artifacts | 本会话发布的 artifact | 列表与预览 | 【宿主工具定义：`show_pane("artifact")`】 |
| 分屏 | Option/Alt 点会话；右键 Open in | 两个会话并排 | 【文档】 |

---

## B. 视觉数值

> 所有取值均以 fizzy-lake（`color panels type` 全开）为准。变量定义在 `assets/v1/c6a992d55-BxgTbpOo.css`（`.cds-root`、`[data-cds-fizzy-lake~=color]` 两层）和 `assets/v1/shared-styles-9rJLMXCT.css`（`.dframe-root`）。基础单位：`--spacing` 4px，`--cds-rem-scale` 默认 1。

### B6. 字体与字号

- 字体族：`--cds-font-sans = var(--font-anthropic-sans), var(--cds-font-system)`。`--font-anthropic-sans` 是 `"anthropic-sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC" …`（woff2 可变字重 300–800，内置在包里，`Resources/fonts/` 里还有 AnthropicSans/Serif 的 ttf）；`--cds-font-system = ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, …`。等宽 `--cds-font-mono = var(--font-anthropic-mono, "SF Mono"), "SF Mono", ui-monospace, Menlo, Consolas, monospace`。衬线 `--cds-font-voice`（Anthropic Serif）只用在“声音”类标题。桌面版默认用系统字体还是 Anthropic Sans，由 `data-font` 决定（默认值函数 `nb()`：判断 userAgent，命中则 system），我没能确认 macOS 桌面默认走哪个，见第 4 节。【前端包：c6059c89c-qJtBWIm7.css、shared-99-Do2dhk0C.js】
- 字重：基础 regular 400 / medium 500 / semibold 580 / bold 600；可变字体轴下深色或 `type` 开启时 360 / 460 / 540 / 560。
- 令牌字号／行高（CDS）：caption 11/17px，footnote 12/15px，code 12/17px，body 13/19px，prose 14/20px，heading 14/18px，title 20/25px；control 高 `--cds-h-control` 24px，图标 16px。
- **对话正文**：容器 `.epitaxy-transcript-typography` 的 `--chat-body` 默认 15px、行高 1.4（设置 “chat text size” s/m/l：14px/1.4286、15px/1.4、16px/1.375，默认 m）。消息行内（`[data-transcript-row] [data-cds=AssistantMessage]`）又改用 `--cds-font-size-body`，随 `data-text-size`：sm 13/19px、md 14/20px、lg 15/22px，缺省 13/19px，行高系数 1.4286（l 档 1.4667）。我没能确认默认 m 档落在哪一档，见第 4 节。【前端包：c6a992d55 CSS `[data-chat-text-size]`、`[data-cds=AssistantMessage][data-text-size]`；shared-36 里 `chatTextSize` 默认 "m"】
- 输入框文字 `--prompt-text-size` 15px，行高 21px（s: 14/20，l: 16/22）。
- Markdown 标题：h1 1.143em / 行高 1.25 / semibold / 字距 -0.01em / 上边距 12px 下 -4px；h2 1.071em / 1.333 / semibold / 上 10px；h3 1em / semibold / 上 7px；h4–h6 1em medium。加粗用 medium(500)。【前端包：c19e90103-DLr2g1Qi.css】
- 间距：回合间距 `--chat-turn-gap = 字号×行高×0.75`（默认 m ≈ 15.75px）；条目间距 `--chat-item-gap = 字号×行高×0.5`（≈ 10.5px）；列表项间距 6px；列表缩进 20px。

### B7. 颜色（CSS 变量与取值）

浅色（`[data-cds-fizzy-lake~=color]`）：

| 用途 | 变量 | 取值 |
|---|---|---|
| 页面/主内容底 | `--cds-surface-1`（`--df-bg-page`） | #ffffff |
| 底层/整页衬底 | `--cds-surface-0` = gray-20 | #f9f9f9 |
| 面板、弹层 | `--cds-surface-2/3`、`--cds-surface-popover` | #ffffff |
| 侧栏 | `--cds-fizzy-lake-color-sidebar` | #fafafa（桌面外壳另用白色卡片＋1px alpha-2 描边＋`0 4px 24px` 6% 阴影） |
| 正文 / 次要 / 弱 | `--cds-text-primary / secondary / muted` | #000000e6 / #0009 / #0007 |
| 分隔线 | `--cds-border`（`--cds-border-line`） | #00000014（#0000001f） |
| 中性填充（用户气泡、行内码底） | `--cds-alpha-1 / 2 / 3` | 中性色 5% / 10% / 20% |
| 悬停、选中 | `--cds-fill-ghost-hover / selected` | #0000000d / #0000001a |
| 强调色（蓝） | `--cds-fill-accent`（hover）；文字 `--cds-text-accent` | #257de0（#2171ca）；#1757ac |
| 成功 | fill / text | #10a122 / #006c10 |
| 警告 | fill / text | #fbb315 / #794c02 |
| 错误 | fill / text | #dc3c3d / #a42528 |
| 主按钮（中性实心） | `--cds-fill-primary` / on | #191919 / #fff |
| Git：新增、删除、修改 | `--cds-text-git-added / removed / modified` | #1e9e3c / #cd2054 / #98801f |
| Git：合并、冲突、草稿 | `…-merged / conflicting / draft` | #8e6bd9 / #c5621b / #737373 |
| 品牌赭色 | `--cds-clay` | #d97757（强调版 #c6613f） |

深色：

| 用途 | 变量 | 取值 |
|---|---|---|
| 页面/主内容底 | `--cds-surface-1` | #191919 |
| 底层 | `--cds-surface-0` = gray-900 | #0b0b0b |
| 面板 | `--cds-surface-2/3` | #1f1f1f |
| 弹层 | `--cds-surface-popover` | #303030 |
| 侧栏 | `--cds-fizzy-lake-color-sidebar` | #1f1f1f（桌面外壳卡片 hsl(0 0% 14.9%)） |
| 正文 / 次要 / 弱 | text 三档 | #ffffffed / #ffffff91 / #fff6 |
| 分隔线 | `--cds-border`（line） | #ffffff0a（#ffffff1f） |
| 悬停、选中 | ghost | #ffffff13 / #ffffff26 |
| 强调（文字用浅一档） | fill / text | #257de0 / #6aabf1 |
| 成功 / 警告 / 错误文字 | text | #53c556 / #e49c06 / #f17778 |
| 主按钮 | fill / on | #efefef / #191919 |
| Git | added / removed / modified / merged / draft | #32d74b / #ff2c56 / #ffd014 / #b796ff / #a6a6a6 |

（基础暖灰调色板的值，例如 gray-20 #f9f9f7、gray-800 #20201f，只在没开 `color` 时回退使用。完整变量表在 scratchpad：`claude-desktop/tokens-*.txt`。）

### B8. 宽度、间距、高度、圆角、阴影

| 项 | 数值 | 来源变量 |
|---|---|---|
| 对话列最大宽 | 768px（默认），960px，1280px | `--transcript-measure` |
| 对话列两侧留白 | 32px（≤560px 的窄槽 16px） | `--chat-gutter` |
| 侧栏宽 | 288px，距窗口 8px，圆角 8px | `--df-sidebar-width`、`--df-radius-card` |
| 侧栏行高 / 行内控件 / 图标 | 26px / 20px / 16px；前导槽 24px | `--df-row-h`、`--df-row-ctl`、`--df-icon-size` |
| 标题栏高 | 48px | `--df-header-h` |
| 控件高 | 24px（嵌套 18px） | `--cds-h-control` |
| 工具/状态行字号 | 与正文同（13–14px，见 B6）；次级说明 12px（footnote） | `.text-body`、`.text-footnote` |
| 内边距档 | 4 / 6 / 8 / 12 / 20px | `--cds-pad-xs … xl` |
| 间隙档 | 6 / 8 / 12 / 20 / 32px | `--cds-gap-xs … xl` |
| 圆角档 | 4（行内码、复选框）/ 6（控件，`--cds-radius`）/ 8 / 10（卡片 `rounded-card`、气泡、面板 `--cds-panel-radius`）/ 12（输入框 `--cds-radius-composer`、xl）/ 16 | `--radius-*` |
| 阴影 | sm：`0 1px 2px` 6% ＋ `0 2px 8px` 8%；md：`0 2px 4px` ＋ `0 6px 16px`；lg：`0 4px 8px` ＋ `0 12px 28px -2px`；弹层：浅 `0 8px 24px #0000001f, 0 2px 6px #00000014`，深 `0 8px 24px #00000052, 0 2px 6px #0003`；卡片 1px 描边 `--cds-border`＋ sm | `--cds-shadow-*` |
| 焦点环 | `0 0 0 1px` 强调色＋ `0 0 6px 1px` 强调色光晕 | `--cds-focus-shadow` |
| 批准卡下限高度 | 168px（带提示 234px；矮窗口里最大高 `max(60vh, 16rem)`） | `--approval-dock-floor` |

### B9. 用户气泡、代码块、行内码、表格

- 用户气泡：背景 `--cds-bg-user-message` = `--cds-bg-neutral`（中性色 5%）；悬停变 `--cds-bg-neutral-hover`（10%）；圆角 `--cds-radius + 4px` = 10px；内边距 12px×8px；最大宽 85%；靠右。助手回复不用气泡（有 `data-variant=bubble` 变体，用在别的场景）。
- 行内代码：等宽，字号＝正文−1px，底 `--cds-alpha-1`（5%），圆角 4px，内边距 1px×2px，行高 1.4；在链接里则变强调色、无底。`kbd`：等宽，正文−2px，1px 边框、底边 2px，圆角 4px。
- 代码块：`.epitaxy-codeblock` / `.epitaxy-fence`，1px `--cds-border` 内描边，等宽 12px/17px（可在设置里改 code font size，行高 `round(12×1.5)`=18px 用于文件行），带 “Copy code” 按钮，滚动条 8px。语法高亮主题默认 `claude-light` / `claude-dark`（设置项 `codeThemeLight/codeThemeDark`；高亮在 `highlightWorker-*.js` 这个 1.5 MB 的 worker 里，具体库未确认）。
- 表格：`border-spacing: 2px`，单元格内边距 6px，圆角 3px；表头底 `--cds-alpha-2` 且 medium 字重，数据格底 `--cds-alpha-1`；空表头隐藏；过宽横向滚动。
- 引用块：左 2px `--cds-alpha-2` 竖线，左内边距 8px，次要色。分隔线 0.5px `--cds-alpha-3`。
- diff：`--diffs-font-size` 12px，`--diffs-gap-inline` 8px，新增/删除/修改色见 B7（git 色）。

### B10. 进行中指示与动效

- **动词现在时↔过去时**：见 A3.1 第 8 条；标签用 `morphKey = {id}:{status}` 做变形，运行中标签至少显示 650ms。运行中的行文字有 shimmer：`cds-shimmer-text-shine`，3s linear infinite，120° 的高光带，墨色＝弱文字色，峰值＝主文字色。
- 状态区淡入淡出：`timeline-status-enter` 0.25s ease-in-out；退出 0.15s ease-out；“火花离场” `timeline-spark-depart` 0.42s linear；跟在火花后进入的延迟 0.21s。
- 展开/收起：`timeline-expand`，0.2s `cubic-bezier(.19,1,.22,1)`，网格行高 0fr→1fr 加透明度；分组展开同曲线；箭头 `transition-transform` 60ms（`--cds-dur-fast`），展开旋转 90°。
- 新块出现：`timeline-block-enter`，从透明＋4px 模糊＋下移 5px＋缩放 .9 过渡到正常（前 30% 保持不可见）。
- 用户气泡入场：0.45s（`--cds-dur-slow`），`cubic-bezier(.34,1.3,.64,1)`，缩放 .92＋上移 6px。
- 任务清单：进行中转圈 `spin 1.6s linear infinite`；完成的对勾描画 0.18s；清单收起 0.2s（`epitaxy-plan-exit`）；不定长进度条 `epitaxy-linear-sweep` 1.1s `cubic-bezier(.45,0,.55,1)` infinite；按钮脉冲 `epitaxy-pill-pulse` 0.42s（scale 1→1.05→1）。
- 侧栏：灰点闪烁 1.2s ease-in-out（透明度 .3↔1）；三点加载 1.8s linear，依次延迟 0.2s；赭色呼吸点 3s（缩放 .86→1、亮度 .96→1.06）。
- 全局缓动/时长令牌：`--cds-ease-out cubic-bezier(.165,.84,.44,1)`、`--cds-ease-snap cubic-bezier(.32,.72,0,1)`、`--cds-ease-overshoot cubic-bezier(.34,1.3,.64,1)`；时长 60ms / 120ms / 200ms / 300ms / 450ms（fast/snap/base/sheet/slow）。所有动效在 `prefers-reduced-motion` 或 `data-reduce-motion=true` 时关闭。

---

## C. 每种元素需要的数据

### C11. 元素 → 最少字段

★ 是对协议设计最重要的行。

| 元素 | 最少字段 |
|---|---|
| ★ 工具行（单个调用） | `id`、`name`（原生工具名或 `mcp__服务器__工具`）、`input`（至少够取出对象：command/description、file_path、pattern、url、query、subagent_type）、`status`（running / completed / error）、`startedAt`（运行中计时）、`durationMs`（可选）、`output` 或结构化结果（`toolUseResult`：Write 要 `type: create|update`，Bash 要 gitOperation/退出码/是否后台）、结果类别标志（`interrupted`、`rejected`、`policyDenied`、`staged`（待批准的提议）） |
| ★ 工具详情 | 详情类型（bash/file/diff/todos/plan/question/…）；bash：命令、输出文本、退出码；diff：文件路径、新旧内容或 hunk、+N −N；read：路径、内容；子代理：描述、状态、耗时、`lastProgressAt`（判断 stalled） |
| ★ 工具组摘要 | 组内按类别的“不同目标”计数（read/edit/write/bash/grep/glob/web/web_fetch/task/…）、每类的 failed/blocked/stopped 计数、是否整类失败；单文件组要文件路径；组是否含运行中成员；总耗时（可选） |
| ★ 助手文字 | 文本（Markdown，流式增量）、是否为“旁白/摘要”（`narration_summary`）、所属回合 `turnKey` |
| 思考 | 文本摘要、是否进行中、耗时秒数 |
| ★ 回合 | `turnKey`、`turnEnded`、开始/结束时间、是否被中断、`turn_error`（原因分类＋可重试提示） |
| ★ 用户消息 | 文本、附件（名称、类型、大小、缩略图）、作者、时间戳、发送状态（sending / queued / not delivered / delivered）、优先级（now / next / later）、可做的操作（编辑重试、rewind、fork） |
| ★ 任务清单 | 有序步骤 `{content, status: pending|in_progress|completed}`；可选关联子会话 `session`、是否“过期”（来自上一条消息之前）、整体 `working` |
| ★ 下一步框 | `recap`（小结）、`ask`（一个问题，可空）、`actions[]`（每个：`kind` 回复或应用动作；回复要 `label`（≤24字）和要发送的 `text`；应用动作要动作名 commit/create_pr/merge/fix_ci/address_comments/resolve_conflicts/verify/archive/new_session）、哪个是主按钮、`blocked`（是否等用户） |
| Recap（离开后） | `recap` 文本、`recapAt` 时间戳（用于一次性关闭） |
| 章节 | `title`（≤40字）、`summary`（可空）、插入位置（消息 id）、是用户置顶还是 Claude 添加 |
| ★ 批准卡 | 工具名、`input`（够渲染 “Allow Claude to {动作} {对象}?”）、可选项（allow once / always allow（作用域说明）/ reject）、是否 `inputWithheld`、批准后的结果态；Plan 批准多一个 plan 文本和接受选项；外部站点的网站名与风险提示 |
| 提问卡 | `questions[]`：`header`、`question`、`options[]`（含 label/说明）、是否多选、可自由输入；结果：已答/未答 |
| 改动汇总卡 | 本回合改动文件列表 `{path, additions, deletions, created?}`、总 +N −N、是否可 Undo |
| 提案卡 | `title`（<60字）、`prompt`/`background`（点 Start 时发送）、发起类型（user_asked / offer / own_initiative）、状态（待定/已开始/已忽略/留在本会话）、目标位置（本地/worktree/cloud/ssh） |
| 通知/事件行 | `notice` 种类（away_summary、agents_killed、prompt_stopped、memory_saved、instruction_size_warning、context_cleared、rewound、forked、compacting、worktree 进出、CI/GitHub/定时事件）＋ 少量参数 |
| ★ 侧栏一行 | `sessionId`、`title`、`liveStatus`/状态类别（idle / unread / working / blocked / error）、`isUnread`、`pendingPermissions` 数、`isPinned`、`taskSummary`（进行中一句话）、`postTurnSummary{status_category, status_detail, recent_action, description}`（结束后一句话）、`lastUserMessage`、`lastActivityAt`、`createdAt`、place（`kind: local|cloud|ssh|bridge` ＋文件夹/分支/主机名）、分支与 worktree、PR（号、标题、状态、CI 状态、+N −N）、分组 `{id,name}`、父会话 `parentSessionId`/`startedBy` 与嵌套数、定时任务 id、是否归档 |
| 会话详情栏 | 分支、base 分支、领先/落后提交数、未提交文件数、PR（号/URL/状态/评审决定/可合并性）、CI（通过/失败/进行中计数＋失败检查名）、Auto-fix / Merge when ready / 归档开关、上下文（已用 token、百分比、auto-compact 起点、分类占比）、运行位置、Remote Control 状态 |
| 面板状态 | 哪些面板开着、窗格布局、diff 范围（all / uncommitted / 某 commit）、当前文件与行号、终端标签 |
| 输入框 | 模型、effort、权限模式、环境/文件夹/分支、worktree 开关、草稿、队列（待发消息列表＋优先级）、附件、斜杠命令/@ 候选、是否运行中（影响停止/排队按钮）、用量/上下文提示 |

### C12. 原生工具归类

见 A3.2 的两张表：先按 `Xc()` 归到详情类型（bash / file / diff / todos / plan / question / peerMessage / agent_status / text），再按工具名给“完成 / 进行中 / 失败”三个动词和对象；MCP 工具没有专用词时显示为 `Used {服务器显示名}: {工具名}`；分组摘要再把它们归到 A3.1 的类别表。几点注意：

1. 动词表是“按工具名硬编码”的，不是按协议字段推导。HarnessHub 如果要统一多家 Harness，需要在协议里给每个工具调用一个归一化的 `category` 和 `detailKind`，否则界面要为每家再写一遍映射。
2. 同一类别要能算“不同目标”：协议要给工具调用一个稳定的 `target`（文件路径或命令文本），摘要才能数对。
3. 状态要区分五种：成功、失败、被用户拒绝/中断、被策略拦截、待批准（提议），摘要里有各自的措辞。

---

## 4. 没找到、没能确认的

- 没有拿到真实窗口截图，所以“实际渲染的字号/字体”没有直接验证：默认聊天字号档（m）落在 13/19、14/20 还是 15/21px；桌面版默认字体是系统字体还是 Anthropic Sans（`data-font` 默认值函数依赖 userAgent，Resources/fonts 里的 ttf 是否被 Code 界面使用）。
- 工具行是否有按种类区分的图标：在行组件里没看到，只看到子代理/任务行有图标（AgentsSimple 等）。
- 侧栏桌面外壳的实际底色：`.dframe-sidebar` 有“白 / hsl(0 0% 14.9%)”和“fizzy 侧栏色 #fafafa / #1f1f1f”两套，取决于外壳变体（desktop 或 web），我没能确认 Code 标签页用哪个。
- 文档页尾 25k 字符（“Coming from the CLI” 对照表等）没读；文档里没有写：侧栏状态点、置顶、未读、Ask-user-question 对话框、Plan 批准卡、Recap（这些靠前端包和宿主工具定义补上）。
- 分组摘要算法在 `c24951e9f`，但调用它的 TurnStatus 头部拼装代码（运行中显示实时状态句还是摘要、展开前后的头部差异）我没有逐行读，A3.1 第 8–9 条里“运行中标签/完成标签”是从行级函数还原的，组头在运行中的显示（例如 “Running 2 commands…” 这种 `IzQEmX8KYb` 文案）来自 `c8af22d2e`（该块更像 claude.ai 聊天的实时状态行），是否同样出现在 Code 里未确认。
- 命令输出、diff、读文件的展开细节（高度上限、折行、复制按钮位置）只看到了 CSS 和零散文案，没有还原完整布局。
- 侧栏行里的 ⋮ 菜单项顺序、分组标题的悬停图标、拖拽排序细节没有逐项核对。
- 动效数值只量了本报告列出的这些，没有重复之前同事的动效校准。

## 5. 对协议设计的直接含义（推断）

1. 时间线只需要四类一等公民：用户消息、助手文字、工具组、事件行；“下一步/任务清单/批准/提问/改动汇总”是挂在回合上的“卡”，不是消息。
2. 工具调用必须带：归一化类别、稳定目标、五态结果、可选结构化结果；摘要和侧栏都能从这些字段推出，不要让界面解析 Harness 原始格式。
3. 侧栏的一句话状态来自两个来源：进行中用 `taskSummary`，结束后用后置摘要（状态类别＋细节＋最近动作）。如果 Harness 不给，Hub 要自己生成，并且要标明是否确认（对应“不谎报”）。
4. 会话需要“等待用户”这个独立状态（黄点），并且区分等批准/等回答/等下一步。

---

## 6. 产出文件（scratchpad，勿拷进仓库）

根目录：`<草稿目录>/research/`

- 脚本 `tools/`：`asar-tool.mjs`（列出/解出 asar）、`css-rules.mjs`（postcss 取规则）、`fmt.mjs`（只格式化 JS）、`i18n-grep.py`、`where.py`（文案→JS 块）、`build-index.py`、`file-strings.py`、`ctx.py`、`enclosing.py`、`cssrules.py`、`tokens.py`。
- 解出的数据 `claude-desktop/`：`ion-dist/`（JS/CSS/HTML/en-US 文案）、`ion-dist-listing.txt`（asar 文件清单）、`tokens-*.txt`（CDS 变量，浅/深、基础/fizzy）、`strings-*.txt`（各块的界面文案）、`fmt/`（格式化后的关键 JS 块）、`index-*.json`（文案键↔JS 块索引）。
- 关键 JS 块：`c96d752d0`（时间线、侧栏之外的会话主体）、`c52b02f3f`（工具→标签映射）、`c24951e9f`（分组摘要）、`c9bd7af9c`（底部栈：任务清单、下一步容器、输入框装配）、`c227f4d5e`（输入框、下一步按钮）、`cc32965c2`（批准卡文案）、`cc43287c9`（会话详情栏与新会话）、`shared-20/21/140`（侧栏）。
