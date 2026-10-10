# ADR-013：实时会话与对话组件

状态：accepted，2026-10-10。用户明确反馈实际 OpenCode 对话无可感知流式输出，要求重做对话 UI、组件与动效；本切片修正实际输送与使用体验，保持 Harness/Provider/模型选择、持久执行及自动择优边界。

## 事实与目标

基线 `0b102d9`。指定会话的两次文本提交相隔 1ms，浏览器活跃时每 500ms 获取完整 Session，Web 的 publish 回调为空。Runtime 每块已先提交再发布，没有等待整轮结果。短突发响应不保证肉眼逐字；验收必须使用有握手间隔的长回复，证明首块在后端结束前已经可见，不制造本地打字延时。

## 输送决定

保留 JSON Session 与分页事件接口，新增同源认证 GET `/api/v1/sessions/:id/events/stream`。采用 SSE，首连/重连读取当前已提交的公共 SessionView，发送 snapshot；实时纯文本提交发送单条 canonical PublicMessage 更新及 version/lastSeq，其他状态变化发送完整公共 snapshot。旧事件无需搬回再执行：重连最新快照覆盖缺失事实，命令身份及执行次数不变。持续传送单条消息避免每个 token 携带完整历史。

帧为 `{type:'snapshot',session:SessionView}` 或 `{type:'message',sessionId,version,lastSeq,message:PublicMessage}`；SSE id 为该帧事实 lastSeq。cursor/Last-Event-ID 严格校验，不允许未来水位。先登记订阅再取得初始事实，不在 await 间隙丢发布。message 快径仅用于独立 text 提交且当前 lastSeq 等于 event.seq；不满足条件给完整快照。

HTTP/订阅所有者限定连接数量、单帧字节、背压等待、心跳和连接期限。写缓冲拥塞时仅保留需要最新 snapshot 的标记，drain 后同步当前持久事实；慢客户端或网络错误只断开该订阅，不能影响 Run 或让 publish 抛进业务提交。关闭订阅、定时器与 listener 后再释放 Store；断开浏览器从不等于取消任务。

浏览器读取 UTF-8 SSE 分片，验证协议、身份、水位及字段后应用消息投影；旧帧不覆盖新 snapshot，消息身份不匹配明确失败并重建事实连接。帧按浏览器实际刷新周期合并显示，最终帧原文完整，不假造 token。重连有所有者、上限和可取消等待，不把 EOF 当任务完成，不自动重发用户命令。500ms Session 轮询退出正常对话路径；目录/安装状态轮询保持独立。

## 对话设计

对标已审阅的 Vercel Chatbot 与 assistant-ui 消息、Composer、ScrollAnchor。暖白背景、约 720px 阅读宽度、16px/1.7 正文；单行自动增长输入，84–104px 默认 Composer，Harness/Provider/模型为紧凑 chip。高级控制与固定配置版本收进披露；dirty/pending 才显示变更动作，不静默改选。手机保持可操作 chip 与发送/停止，不将配置堆成多行大卡。

用户气泡与助手正文区分；正常完成没有每轮常驻状态页脚。复制、编辑草稿、执行信息只有真实能力，hover/focus 或触屏可达；不能把编辑草稿说成重新执行。无文本时显示准备/生成反馈，收到文本后显示实际内容及轻微活动提示。停止、失败、未知保留部分内容和明确状态。用户上滚中断跟随，返回最新回复显式恢复；resize 和流式 Markdown 增长保持底部跟随但不抢阅读位置。动画尊重 reduced-motion。

采用独立流式 Markdown 展示边界处理不完整语法：既有 `react-markdown@10.1.0` / `remark-gfm@4.0.1` 保留，新增 `remend@1.4.0`（Vercel streamdown 的独立包，Apache-2.0）只在生成中修补展示文本，最终展示和复制仍使用持久原文。依赖在package.json及pnpm锁文件固定，来源与许可由安装包元数据核对。不会引入另一个 Chat Runtime 或把 Gateway Session 绑定到第三方 UI 框架。

## 所有权与验收

后端负责人：`src/contracts/web.ts`、`src/web/server.ts`、`src/web/session-stream.ts`、`tests/integration/web-session-stream.test.ts`。流式消费负责人：`web/src/session-stream.ts`、`tests/unit/web-session-stream.test.ts`。前端组件负责人：ChatPage/styles、ChatComposer/ChatMessage/StreamingMarkdown。主负责人：App/api、依赖/工程文档/门禁及浏览器验收。文件不重叠。

测试保持真实 HTTP、SQLite、Runtime、Driver 和进程，外部 Harness/模型可夹具。覆盖首块先于完成、SSE 分片/UTF-8/CRLF、重复/过期/身份错误、缺帧重连、断订阅继续执行、取消部分文本、未知不可重跑、背压/预算/关闭、消息动作/草稿/滚动/IME/小屏/reduced-motion；原 Provider/安装/升级验收仍回归。真实长流通过本地确定性 Provider 验证，不把测试模型当云模型质量。

实施状态：本机切片已实现，实际命令、版本、结果与局限见[实时对话验收](../verification/live-chat-2026-10-10.md)。
