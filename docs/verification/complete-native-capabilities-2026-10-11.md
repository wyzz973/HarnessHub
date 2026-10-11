# 所有Harness原生能力补齐（2026-10-11）

依据[ADR-020](../decisions/0020-complete-native-harness-capabilities.md)。用户要求完整能力适用于所有已接入及后续接入的Harness；采用统一聊天界面，沿用原安装、配置和登录。完整目标仍进行中，不能把本轮原生恢复或协议连通称为全部原生能力完成。

## 本轮实现

- ACP按实际声明load/resume恢复；回放只验证原生身份及预算，不创造新公共回复/工具事件。原生模式不再因同时存在思考选项而被隐藏。
- Codex持久thread/start及thread/resume；恢复期间先绑定预期thread身份。thread级元数据不绑定当前Turn；输出/控制仍严格匹配当前Turn。原生问答逐个回传实际标签/输入，密码输入遮蔽且回答正文不进入权限事件；思考输出来自真实原生事件。
- Pi目录探测保留no-session；正式执行使用原CLI持久session。恢复原session文件和身份，原模型用启动参数覆盖，思考用不persist的原RPC。重新读取状态不丢原命令目录，本机接口实际有70条命令。
- OpenClaw保留Hub自己的Gateway键和ACP身份，load时requireExistingSession=true/resetSession=false；不改其他会话或全局配置。
- 公共Session v6新增私有原生绑定和已同步Run，恢复仅补入切走期间新增公共事实。私有checkpoint不进入Web DTO；DTO只显示ready/unconfirmed。
- 派发前持久标记unconfirmed，后端结算和进程关闭确认后才ready。未知状态拒绝再派发；显式重新建立原生会话保留旧引用及公共历史。该动作是公共文本重建，不能冒称厂商native_fork。
- macOS已退出根进程的EPERM延后到原有有界进程组收敛核实；任何活成员、枚举失败或超期仍失败，不能仅凭EPERM宣称已清理。此路径不改变在途任务结果或静默重试任务。

## 实际证据

| 检查 | 结果与范围 |
|---|---|
| `pnpm test` | 478通过、0失败、0跳过；真实SQLite/IPC/HTTP、v5→v6/拒绝回滚、增量接续、跨进程恢复、未知保护与问答 |
| `pnpm build`、`pnpm web:build` | 前后端严格类型与正式构建通过 |
| `node --test dist/tests/browser/web.browser.js` | 四项浏览器场景，原设置/快速切换/审批刷新取消与响应式；实际结果以本轮私有日志为据 |
| `pnpm check:design` | 341个计划场景与所有权/生成视图一致；它不运行这些计划测试，不打开未来完整Gateway实现门 |
| 正式Runtime/SQLite＋原OpenClaw2026.3.23-2 | deepseek/deepseek-chat＋low：新进程恢复后正确回复上一轮随机标记；sourceRunIds=[]，无旧公共历史重新注入，completed/end_turn、clean closure（原exit1保留） |
| 同入口＋原Codex0.162.1 | gpt-6.1-sol＋low：同样正确记住随机标记，sourceRunIds=[]、completed/cleanup.closed、exit0 |
| 同入口＋原Pi0.85.1 | deepseek/deepseek-flash＋low：恢复原文件后同样正确记住随机标记，sourceRunIds=[]、completed/cleanup.closed、exit0 |

真实结果在忽略路径`.tmp/native-complete-real-combined.json`，OpenClaw和Codex/Pi分别保留原日志。4份原模型配置内容摘要前后相同，见`.tmp/native-complete-config-proof.json`。没有把临时测试失败的未知Run改成通过或自动重跑。

Codex真实恢复最初失败：恢复元数据到达setup响应之前时，conversation尚未绑定；修复后又发现thread/tokenUsage/updated携带原第一轮Turn ID，误绑定到第二轮。原SDK只读thread/read确认旧测试第二轮interrupted，原状态仍保留unknown。私有诊断仅记录方法与身份，确认用量通知先于新turn/started；修复及对应IPC反例后，新独立测试会话通过。

## 七个原安装的接口审核

原接口initialize/目录/关闭的实际记录在`.tmp/native-complete-capability-audit.json`，全部关闭确认。这些读取不是生成、工具或完整功能验收。ACP标志不能用来判定另外两种协议。

| 本机Harness | 实际原接口 | 本次目录/选项 | 原生恢复与当前限制 |
|---|---|---|---|
| Codex | 原app-server | 7模型及各自reasoning档位 | thread/resume真实通过；其他原生动作仍逐项补齐 |
| Claude Code | 原CLI＋ACP0.89.1 | 13模型、4设置组 | 实际声明load及resume；本机额度限制下未完成真实生成恢复验收 |
| OpenCode | 原1.18.35 ACP | 11模型、1模式组 | 实际声明load及resume；原生恢复接口已接，真实恢复验收仍待补 |
| OpenClaw | 原2026.3.23-2 ACP/Gateway | 4模型、7设置组、27命令 | load/Gateway键真实通过；后台Gateway/工具等仍按原能力逐项验收 |
| Gemini CLI | 原0.62.0 ACP | initialize实际声明load/image/audio | session setup返回NATIVE_CLIENT_UNSUPPORTED，不能说模型/回复恢复已通过 |
| Cursor | 原已登录CLI ACP | 44模型、1模式组 | 实际声明load；公共任务套餐限制与生成恢复另行验证 |
| Pi | 原0.85.1 RPC/SDK | 11模型、70命令、模型专属档位 | 原文件恢复真实通过；RPC未开放的TUI专属组件仍需适配路线 |

ACP原接口声明的image/audio/embeddedContext只说明原Harness有该接口能力，当前Hub文本输入尚未接出附件；Codex/Pi的图片入口以原JSON Schema及RPC源码为据，不能把缺少ACP标志解释为没有图片能力。

## 完整接入仍缺少的验收

所有Harness都必须覆盖实际具有的输入（图片/文件/音频）、计划/工具详细结果/用量、命令改变原配置后的界面同步、原生分支/压缩/恢复、插件/MCP/skills交互、原生子Agent及后台任务、产物/导出与权限。当前不能把这些未实现或未验证项标完成。未安装的36个目录产品不自动安装，不从43产品/47控制描述或通用协议测试推断全部兼容。Windows尚未原生验收。

## 原对话上线核对

旧服务空闲后正常停止，备份v5业务库及管理库后在同data根启动v6。备份路径保存在忽略文件`.tmp/native-v6-backup-path.txt`；`.tmp/native-v6-live-migration-proof.json`确认schema6、会话数量与全部旧历史/水位/命令/Run逐项不变。

原对话第13和14轮均由原OpenClaw/DeepSeek Chat/low正确回复「你好」；第14轮sourceRunIds为空，通过已有原生会话接续。ready绑定保留，Session open。见`.tmp/native-v6-live-replies.json`及`.tmp/native-v6-live-settings.png`。最终4份模型配置摘要再次相同，见`.tmp/native-v6-live-config-proof.json`。原来的失败记录没有删除，界面可继续使用。
