# 对话故障恢复与交互逻辑审查

日期：2026-10-10，Asia/Singapore。基线11c151e。范围：当前已经实现的会话、执行、选择、连接、Provider、Harness管理及页面交互；不以目录43个产品等同43个实际执行组合。

## 审查结论

已修正的核心问题是连接错误与清理未知混用、单会话故障毒化整个Runtime、失败切换缺少恢复动作、导航/刷新丢草稿、业务拒绝误成未知执行、原始RPC错误反射、原生连接标签暗示已经认证，以及结束会话可被误触。故障归属于对应消息、选择或资源；用户仍可保存草稿、查看历史、明确改选或恢复。真正未知资源/存储/归属故障保留执行限制，不自动重跑或用新空会话冒充恢复。

市场参照为2026-10-10阅读的[Vercel AI SDK Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)的Status/Error State/Stop/Retry，以及[assistant-ui AI SDK](https://www.assistant-ui.com/docs/api-reference/integrations/ai-sdk)的消息状态和传输所有权。它们支持错误呈现与用户恢复动作，本项目另外保留编码Agent的执行、工作区与未知副作用边界，不能照搬纯文本Chat的自动重试。决定见[ADR-014](../decisions/0014-conversation-failure-recovery.md)。

## 已实现逻辑逐项审查

| 场景 | 用户行为与当前结果 | 验证 |
|---|---|---|
| 新建/首次连接失败 | 本条输入failed，历史保留；close确认后Session继续open，可改选 | 新Runtime用例、真实HTTP |
| OpenClaw认证缺失 | GATEWAY_AUTH_REQUIRED，正文说明认证未配置；不回显stderr/凭据 | 真实本机probe、协议进程、浏览器 |
| 目标切换失败 | 原有效选择/epoch保留，立即说明失败，可“继续使用当前选择”或改选 | HTTP与浏览器同Session流程 |
| 等待失败切换的消息 | 明确未派发，不能静默交给旧目标；用户明确重发 | FIFO/HTTP/Runtime回归 |
| 生成中的选择变更 | 当前Run固定配置，等待原执行和清理；无活动回复时显示验证新连接 | Runtime竞态、浏览器回归 |
| 模型/协议明确拒绝请求 | ACP的prompt错误响应、Codex尚无turn的请求拒绝记failed；不制造未知执行 | 实际协议对端进程 |
| 已结算后协议异常 | backend和closed清理保持，公开failed；禁止冒充completed，允许新任务 | duplicate-complete实际进程 |
| 派发后结果未知 | 原Run unknown不改写；资源已关闭时用户明确承认后resume，只开始新任务 | Runtime握手/队列/幂等 |
| 清理未确认/工作区隔离 | 不派发同工作区新写入；草稿/历史/选择仍可操作，说明需核实资源 | 清理故障与workspace测试 |
| 单会话故障 | 仅阻断对应Session；其他工作区/会话继续 | 新隔离用例；正式工作区租约回归 |
| Store/owner/公共发布失败 | 仍停止全局准入，不能假称恢复或持久成功 | 既有故障注入与恢复拒绝用例 |
| 旧误阻塞会话 | 新resume意图检查原关闭证据和真实目标，成功后同ID、新epoch；不改旧记录 | HTTP重启/legacy状态用例，现场检查 |
| 发送ACK丢失/超时 | 同commandId确认接收，草稿和身份保留，不重复派发 | API、浏览器故意丢ACK |
| SSE断线/刷新 | 重新读已提交快照，不重发消息或把EOF当完成 | SSE集成、真实Codex、浏览器 |
| 停止与部分内容 | 取消受理与执行结束分开，已到达文本保留；后续可明确发送 | Runtime、HTTP、浏览器 |
| 重试回复 | 用户点击后新Run，原failed/cancelled和部分内容保留；unknown没有一键重跑 | 浏览器FAIL_ONCE与Run身份断言 |
| 切换对话/刷新草稿 | 按工作区/Session保留正文、选择和未确认命令；保存标记由服务端事实确认 | 新浏览器往返/刷新用例 |
| 浏览器草稿存储损坏/不可用 | 未知字段/类型/超预算不作为业务输入；保存失败保留内存并提示 | 边界人工复核、浏览器未知字段拒绝且不创建/派发反例 |
| Provider停用/丢失/不兼容 | 禁止新发送，选择器仍可改；不偷偷替换Provider或模型 | Provider服务/HTTP/浏览器回归 |
| Provider编辑与固定revision | 旧Run和已生效Session不自动更新；明确使用最新再应用 | 不可变revision/CAS/浏览器 |
| Provider编辑取消/未保存 | 离开提示，保存失败保留输入；不将密钥写到草稿存储 | 既有表单回归与可见/storage Key扫描 |
| 结束会话 | 原生模态框明确永久停止准入，取消不提交close，确认保留历史 | 新浏览器确认/取消及刷新只读 |
| 发现/安装/认证 | 有程序或控制入口不当作连接通过；“Harness原生连接”说明仍需认证 | 文案复核、发现/协议回归 |
| 安装失败/取消/未知 | 旧默认保留、日志和任务持久；没有无依据重试或exit0冒充验证 | 全部管理回归、安装UI流程 |
| 升级/更新检查 | 私有版本不覆盖旧Run；真实入口验证后切默认；检查失败不宣称最新 | 管理/接线组合、安装升级浏览器 |
| 键盘/IME/滚动/窄屏 | 状态与动作可达，流中阅读位置保持，停止按钮/紧凑选择不溢出 | 既有和新增浏览器流程 |

## 实际检查

环境：macOS27.0.1 arm64，Node25.9.0，pnpm10.12.3，TypeScript5.9.3，Playwright1.64.0/配套Chromium；真实Codex0.160.0、Gemini本机现有安装。外部模型为确定性本地服务，不读取个人模型凭据或代表云模型质量。

| 实际命令 | 最终结果 |
|---|---|
| `pnpm build`、`pnpm web:build` | 后端/前端严格类型与生产构建通过 |
| `node --test dist/tests/*/*.test.js` | 418通过，0失败/跳过，约6.3s；`.tmp/recovery-tests-delivery.log` |
| `node --test dist/tests/browser/web.browser.js` | 3个完整浏览器场景通过，0失败/跳过；`.tmp/recovery-browser-delivery.log`。收尾追加无效缓存不创建/派发的反例 |
| `node --test dist/tests/real/codex-session.real.js dist/tests/real/harness-provider-switch.real.js dist/tests/real/live-web-stream.real.js` | 3通过，0失败/跳过，约5.1s；`.tmp/recovery-real.log` |
| `pnpm probe --harness openclaw --json` | 预期拒绝：Gateway认证未提供；公开错误GATEWAY_AUTH_REQUIRED，cleanup.closed=true/exitCode1，无prompt |
| `python3 tools/check_design.py --write`、默认检查、`git diff --check` | 通过；26需求、81任务、321蓝图场景、7个accepted切片，完整未来门禁仍false。检查不执行Runtime测试 |

首次完整回归有两条旧反例把schema3当未知；v3成为已知格式后，将未知样例改为4，并保留未知格式必须抛错的断言，另加v3接受样例。不是删除反例或放宽检查。重新执行完整418项通过。首次新增浏览器场景在新Session尚未创建时读取URL，改为等待真实创建水位后仍严格断言同身份/Run数量/草稿。

## 存储与真实页面

业务格式迁移v2→v3，既有v1→v2步骤保留。真SQLite用例验证身份、已完成消息、命令指纹、事件和水位不变，blocked不自动打开；两条后置损坏用例验证v1/v2升级整笔回滚。新格式使旧程序明确拒绝读取，不能直接降级二进制后继续使用v3数据库；恢复旧备份前须停止新服务。

现场更新前确认没有活动Run、待生效切换或安装任务，正式入口正常停止。使用SQLite备份接口保存升级前业务库，私有目录/0600文件在`.tmp/pre-recovery-v3-*/`，不进入提交。新服务启动后，原会话全部messages/runs/switches的规范化hash、version、lastSeq保持，格式3且仍blocked；只执行格式迁移，没有隐式恢复。

现场的原会话先显示可编辑输入、可选Harness与“检查连接并恢复对话”。通过此入口完成真实OpenCode初始化/open/close后，原公共Session恢复open、epoch从1到2；原messages/runs与原失败switch逐项不变，新增switch.requested/validated/effective，recovered=true且cleanup.closed=true/protocolFailure=null。没有新Run或prompt，页面不再显示“需要核实”，输入和选择器可操作，辅助状态为“可以继续对话”。证据在忽略目录`.tmp/live-recovery-verification.json`；这证明真实连接检查与会话恢复，未发送新的云模型任务。

截图在`artifacts/chat-v3/`，新增`harness-selection-failed.png`、`preserved-chat-drafts.png`；其余既有安装/升级、流式、窄屏、停止与完成截图由3个场景更新。真实运行数据、配置、备份和日志不入Git。

## 当前边界

OpenClaw自身仍缺Gateway认证配置，本轮修正其错误分类与失败恢复，未读取/注入个人Gateway Token，也未声称其模型任务通过。真实执行回归为上述Codex/Gemini组合及本地模型；其他目录产品、云模型、Windows/Linux未按本轮组合逐项验收。

真正未确认停止的工作区仍需要核实，不用新会话/清租约绕过；Store/owner故障不能在UI假造恢复。草稿保存在当前浏览器标签页的sessionStorage，关闭标签页后不承诺草稿保留；Provider凭据不在其中。自动择优、完整代理/账本和原生无损跨Harness迁移仍不在当前范围。
