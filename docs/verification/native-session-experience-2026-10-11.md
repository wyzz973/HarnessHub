# 快速选择与原生会话能力验收（2026-10-11）

依据[ADR-019](../decisions/0019-native-session-experience.md)。用户确认“统一聊天界面，按每个 Harness 接出原生功能”；不使用嵌入原生终端作为能力替代。当前实现位于HarnessGateway，HarnessHub既有未提交文档保持原状。

## 变更与不变量

旧实现在每次普通选择启动目标、建立会话再关闭；模型探测再启动一次；真正发送又启动。原对话事实的最近切换耗时：Claude约2936ms、Codex4288ms、Cursor7828ms、Pi728ms、OpenClaw1327ms。

普通选择现在只验证本机配置/入口、提交并发布选择，不产生原生子进程。effective表示下一条消息的配置选择生效；不表示认证、额度或网络已成功。在途输入与清理顺序不变，后来的输入等待该选择，失败不派发到旧Harness。显式blocked恢复仍初始化/建会话/关闭确认。执行每次重新观察原安装，不用缓存驱动派发。

目录成功且非空的结果缓存60秒，最多8项；同请求合并。原安装/配置身份变化与显式刷新失效；失败和空结果不缓存。缓存身份读取和真实子进程探测都由关闭入口等待。前端复用按Harness/入口/模型/工作区区分的目录，目录读取不阻塞切换/编辑；模型专属选项另读原接口。无法读取选中模型时保留用户选择与目录、显示问题，允许重新选模型；没有执行fallback。

原生模型、思考、模式及所有select配置保留原ID与值，不合并不同工具的档位词汇。切换回同一Harness恢复本对话最后选择；模型变化保留独立设置，重新确认模型相关档位。OpenClaw使用原CLI的models.list及仅本轮Hub键的sessions.patch，不写全局模型配置。原ACP的6组配置与27条命令均来自实际接口。

新增v5存储保留v4→v5事务迁移。nativeOptions、思考与工具活动、权限决定命令均有严格边界；旧schema不能承载新字段。用户决定先提交，再回复真实原生选项ID；同命令重试不重复回复，冲突拒绝。没有原生ACK时明确backendAcknowledged=false。取消/关闭释放待决请求，原生进程和工作区租约关闭结果仍独立核实。

Codex不再注入强制只读/固定审批策略，继承本机配置并提供审批交互。Pi使用本机SDK真实思考目录，RPC设置不persist全局；原生confirm/select/input/editor交互接入统一界面。原MCP/skills/插件继续由原程序加载。原生思考文本与工具状态来自实际事件。命令按原命令入口发送，事件注明publicContextInjected=false；公共文本接续不等于原生工具状态或会话内部状态无损迁移。

## 实际本机证据

- 原OpenClaw2026.3.23-2：实际4个模型、6组原生选项、27条命令。选deepseek/deepseek-chat及thought_level=low后，正式Runtime/SQLite/原进程真实回复“原生选项接入成功。”；completed/end_turn、cleanup.closed=true、protocolFailure=null，原ACP退出码1如实保留。
- 原Codex0.162.1：实际7个模型及各模型supportedReasoningEfforts。选gpt-6.1-sol、reasoning_effort=low后同入口真实回复；completed、cleanup.closed=true、exit0。
- 原Pi0.85.1：11模型，原安装AgentSession的思考目录；deepseek/deepseek-flash、thinking_level=low真实回复；completed/stop、cleanup.closed=true、exit0。最初用CJS解析ESM-only兼容导出失败，已改成从原CLI安装目录读取原AgentSession纯目录方法，未改原SDK文件或编造静态列表。

以上真实轨迹在忽略目录`.tmp/real-native-experience.log`、`.tmp/real-native-pi-experience.log`。4份模型配置文件内容摘要前后相同，见`.tmp/real-native-experience-config-proof.json`，最终原对话验证后再次核实4份配置不变，见`.tmp/native-experience-final-config-proof.json`；不导出原配置内容/Key。

## 范围与未通过项

这次接通的是实际已暴露的配置、命令、审批和交互；不能称全部43个目录项或全部原生功能已等价。当前公共输入仍为文本；原生checkpoint/resume、跨Harness工具内部状态、持久后台任务及TUI专属组件还没有完整统一界面验收。Pi RPC源码明确不提供原TUI组件工厂、footer及raw terminal input，不能伪造这些接口。按用户统一界面方向继续逐项实现，未支持需明确展示。

Claude额度、Gemini个人链路停用、Cursor公共对话套餐限制保持原事实。Windows尚未原生验收，当前资源保护与真实引擎结果限于macOS。设计蓝图数量不是运行通过数量。

## 正式原对话与迁移

停止旧服务前核对原对话空闲，备份业务库和管理库；本轮更新在相同data根启动。业务库user_version=5，管理库不迁移；迁移后会话数量、旧消息/Run/switch/command及历史水位均保留。备份目录为忽略路径`.tmp/native-experience-v4-backup-2026-10-11T06-44-20.728Z`，迁移比较在`.tmp/native-experience-live-migration-proof.json`。没有清库或重跑历史。

原`session-80ac61ac-88d8-4614-b96b-c88d2cfc04f4`的浏览器直接选择OpenClaw→DeepSeek Chat→低，随后Codex→Pi→OpenClaw；返回时保留DeepSeek Chat和low。第21至25次选择的持久requested→effective间隔分别81、52、88、79、96ms，见`.tmp/native-experience-live-switch-timings.json`。这是选择提交间隔，不是UI点击延迟、原程序首次启动或模型首token时间。

第12轮实际发送“切换验证：请只原样引用这段公共对话最早的用户消息，不要调用工具。”；原OpenClaw2026.3.23-2、deepseek/deepseek-chat、thought_level=low回复「你好」，与最早用户消息一致。正式SQLite记录completed/end_turn、cleanup.closed=true、exitCode=1、protocolFailure=null；Session仍open且无activeRun。见`.tmp/native-experience-live-reply-proof.json`。刷新最终页面后模型/档位/回复仍在，页面截图`.tmp/native-session-experience-chat.png`。ACP退出码与任务结算独立保留，不能只用退出码判断成功。

## 检查与缺陷反例

| 实际入口/命令 | 本轮结果及范围 |
|---|---|
| `pnpm test` | 468通过、0失败、0跳过；SQLite迁移/回滚、RPC、HTTP、资源、选项/审批边界；不能代替真实云模型或Windows |
| `pnpm web:build`、`pnpm build` | 前后端严格类型检查与正式构建通过 |
| `node --test dist/tests/browser/web.browser.js` | 四项浏览器场景；统一界面模型/档位、快速改选、在途/取消/恢复、审批刷新与取消、320/390/943响应式 |
| `pnpm check:design` | 338个计划场景与所属切片/生成视图一致；计划状态不是运行通过状态，完整未来Gateway实现门仍关闭 |
| `.tmp/real-native-experience.mjs`与原安装 | OpenClaw、Codex、Pi三组原模型+low档位实际回复、资源关闭与配置摘要保护；只限本机所测版本和组合 |

发现并修复命令目录读取期间取消仍可派发的问题：新门控测试在修复前确认错误派发1次，修复后派发0次、backend=null、公共cancelled、cleanup.closed=true且会话open。实际原生命令按原始`/native-help fixture`派发的IPC及持久事件另有断言；没有把命令填入输入框视为执行通过。审批决定沿用命令预算，非法输入/选项、重试与冲突分别拒绝或回放。

全套检查曾暴露macOS根进程退出后进程组EPERM。原始失败时完整进程表未留存，不能事后断言该组具体状态；修复依据原Apple XNU：已观察本轮根进程退出且EPERM时，才用有界系统进程表核实组内成员。任何活成员、格式错误、空枚举或枚举失败仍拒绝清理成功。没有取消沙箱保护或把任意EPERM吞掉。拒绝样例与CLI取消/输出上限/非法UTF-8均已运行。
