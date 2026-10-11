# ADR-022：原生活动事实、内容存储与运行帧

状态：accepted，2026-10-11。依据[ADR-020](0020-complete-native-harness-capabilities.md)、[ADR-021](0021-native-profile-and-deviation-tolerance.md)与[能力矩阵](../verification/native-capability-matrix.md)。用户要求统一聊天界面按各 Harness 实际能力接出工具与审批、产物等原生能力，先完成“用户 → HarnessHub → 各 Harness 回复”。

## 背景

各原接口在回合中报告的远不止文本：

- 工具的输入、输出、退出码、文件差异与位置（Codex `commandExecution`/`fileChange`/`mcpToolCall`，ACP `rawInput`/`rawOutput`/`diff`/`locations`，Pi `tool_execution_*` 与 `details.patch`）；
- 计划（Codex `turn/plan/updated`，ACP `plan`）、用量（Codex `thread/tokenUsage/updated`，ACP `usage_update` 与 PromptResponse.usage，Pi `message_end.usage`）；
- 提示（警告、配置警告、改路由、扩展通知）与活动（子 Agent、上下文压缩、自动重试、代码审查）；
- 非文本产物（ACP 图片与资源链接，Codex 生成图片的 `savedPath`）。

v6 只保留工具 id、标题和状态，其余被丢弃或记为诊断。工具输出与整文件差异可达数十 KiB，放不进单条事件（2 MiB）或会话输出预算（1 MiB），也不应随每个流式增量写入。

## 决定

1. **控制契约。** 新增 `tool.detail`（kind、name、input、output、diff、locations、exitCode、parentId、truncated；输入 16 KiB、输出与差异各 64 KiB，超出保留尾部并标记 truncated）、`plan`、`usage`（turn、context、cost，费用标注 turn 或 session 作用域）、`notice`、`activity`（subagent、task、compaction、retry、review）与 `output`（字节内容或链接）。驱动只映射原协议实际字段，不推测语义；例如 OpenCode 的 todowrite 仍是工具，不当作计划。
2. **Session v7。** PublicRun 增加工具 kind/name/parentId/exitCode/detail（内容引用）、plan、usage、notices（≤32）、activities（≤64）、outputs（≤32）。v6→v7 全事务迁移，历史不改写；旧程序拒绝 v7。
3. **内容存储。** 详情与产物进入数据根下独立的 `content` 目录：按 sha256 内容寻址，文件 0600，记录在 `content.sqlite`；类型以魔数判定，SVG 与伪装图片只作文件；写入受 Store owner 守卫。启动时 owner 独占且静止，回收超过 7 天且未被任何 Run 引用的记录与 blob；总量 4 GiB、262144 条；超出后新的详情与产物不再保存，Run 记录诊断，回合不受影响。事件日志只存摘要和内容引用，不存预览或字节。
4. **时序。** 工具摘要变化即提交；详情在工具终态时存储，以 `run.tool_detail` 发布引用；回合结算后、绑定关闭前，先存完所有未存详情和产物。存储失败写一条诊断，不吞掉，也不改变回合结论；owner 丢失仍按原规则致命。Codex 生成图片在回合结算前读完（只读有界常规图片文件），节流中的输出在结算时送达。
5. **提示去重。** 同一对话中已显示过的相同提示（严重级、标题、详情都相同）只写日志，不再显示；原程序每轮重启时会重复启动警告。
6. **Web。** `GET/HEAD /api/v1/content/:id` 需要登录且同源；只内联 png/jpeg/gif/webp/json/plain，其余强制下载，响应带 CSP sandbox 与 nosniff。SSE 新增 `run` 帧，只替换活动 Run 的原生活动字段；客户端发现事实缺失时改取完整快照。
7. **ACP 客户端。** 声明 `session.notices` 与 `session.compaction` 能力（已用七个原安装的 initialize 审计确认被接受）。未宣告的客户端方法回 -32601，并在当前 Run 留一条审计诊断；OpenCode 批准编辑后调用的 `fs/write_text_file` 属于这一类，编辑仍由原程序自己完成。
8. **界面。** 统一聊天在回复下展示计划、提示、工具列表（展开时按需读取详情，差异着色）、活动、产物与本轮用量；状态不只靠颜色表达。

## 影响与迁移

- 升级时业务库 v6→v7；更新前备份数据根（含新 `content` 目录）。回退旧程序需先停止服务并恢复升级前备份。
- 本轮不做：文件、图片、音频输入；原生命令改配置后的同步；会话列表、分支、压缩、回退动作；后台任务；Codex 计划模式与审批/沙箱设置。

## 否决方案

- 把详情内联进 Session 聚合或事件：会超出聚合与事件预算，读取整段会话的代价随工具输出增长。
- 每个流式增量都写详情：写放大。改为运行中只提交摘要，终态或结算时存详情。
- 把 OpenCode todowrite 推测成计划：原程序没有发 ACP plan，推测会伪造原生语义。
- 为接住 `fs/write_text_file` 而声明 fs 能力：Gemini 等会改由 Hub 读写文件，偏离原程序自己的文件行为。

## 验收

协议测试覆盖三类驱动的映射与边界；Runtime 测试覆盖预算、结算前写入、日志只含引用和提示去重；提示去重与 Codex 图片读取、结算送达已做变异核验，确认测试能拒绝缺少修正的实现；Web 测试覆盖内容路由与 run 帧；浏览器测试覆盖界面。真实原安装：Codex、OpenCode、Pi 的命令与编辑回合，OpenCode 工作区级审批。见[本轮验收](../verification/native-activity-2026-10-11.md)。
