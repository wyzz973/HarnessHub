# 公共Session本机切片

状态：accepted，仅限ADR-010的S03/S04。

身份分别为SessionId、RunId、MessageId、SwitchId、CommandId；当前存储格式schemaVersion=8（v1为初始切片，v2加入Provider引用，v3加入明确恢复语义，v4加入nativeModel和安全backend.error，v5加入nativeOptions、思考/工具活动和权限决定命令，v6加入私有原生绑定和显式重建命令，v7加入原生活动事实：工具种类/退出码/详情引用、计划、用量、提示、活动与产物引用，以及输入附件引用，v8加入分支来源与原生fork引用状态），严格校验未知字段、关系与上限。公共Session保存workspace、私有配置引用、实际selection/epoch、命令幂等、Run与消息；不保存配置正文/凭据/原生内部状态。聚合最多256Run/1024命令、每输入64KiB、每输出1MiB、完整context1MiB、最多8排队输入；超限明确拒绝/失败，不裁剪历史。

所有Store操作同步且事务内不await；commit通过expectedVersion CAS，聚合和非空事件同事务，seq连续。命令/历史append-only，已终结证据不能改写，关系/来源/水位/epoch严格校验。事件单条2MiB+4096，Session日志32MiB；读页1..100项/8MiB，超限不裁掉同一历史。Runtime同步回调提交control事实后才emit；发布失败不重跑，持久游标可查询。

一个数据根一个OS owner，owner锁rollback journal+BEGIN EXCLUSIVE；业务库WAL/FULL。新owner须验证旧owner已不活跃或显式正常释放，不能因TTL过期接管。路径身份变化/事务丢失/generation不匹配fail-closed。workspace锁跨数据根按canonical路径键排他，只有关闭确认后清除held状态；异常遗留held不自动认作可执行。

Runtime准入send/switch/cancel/close/permission先查commandId和fingerprint；同请求返回原身份，不再派发。每turn一个active writer；原生会话按实际Driver恢复能力接续，私有checkpoint不进入Web DTO。没有已验证恢复接口时新native conversation；fresh context包含所有已terminal Turn的public user/assistant及状态，再加本turn输入，排队的其他用户输入不能提前进入prompt。完整历史超预算在启动前拒绝。

switch请求先记录pending/requestedSeq，默认wait_current并遵循FIFO准入：请求前queued保留原选择且先执行；请求后输入记录awaitingSwitchId，只有该切换effective才执行新目标，失败则明确未派发，不自动回退。确认旧结果/cleanup后，用请求前已终结Run限定sourceRunIds，普通目标只验证入口/配置后effective、epoch+1并更新throughSeq，不初始化/open/close原生连接。effective不说明模型认证、额度或网络成功；实际连接留到发送时建立。后来的输入即使被cancel成terminal也不进入旧水位；不同pending冲突。

cancel queued持久tombstone后不启动；preparing在await后核对；active取消仅受理/发送回执。公共cancelled表示用户撤回且资源已收敛，竞态中backend仍可能completed，事实必须同时保留，不能以公共标签声称后端没执行。prompt派发后backend未结算或cleanup未知进入unknown/blocked；初始化/open失败且close确认则本轮failed，Session可继续。已结算后protocolFailure保留backend/cleanup事实并令本轮failed，不宣称完成，也不把已停止资源说成未知。

重新打开Store，将preparing/running/settling记unknown/block，queued取消，pending switch失败，不重放。普通Session以同公共ID续接并public_context_rehydrate；closed/blocked不接收普通执行或切换。会话级未知不毒化其他工作区/会话；真实Store/owner/公共发布故障仍停止整个Runtime。CLIEOF/:quit先停止准入，取消未执行队列并关闭active资源后释放owner锁；Session历史仍在。

按[ADR-014](../decisions/0014-conversation-failure-recovery.md)，blocked允许显式resume：验证持久阻断与close证据，unknown必须closed且明确acknowledgeUnknown；所有权/存储/发布故障、缺证据或资源不明拒绝。以新的switch命令及recovery标记重新获取工作区租约、初始化/open/close目标；成功后同Session新epoch变open，旧终态不改写，原排队输入取消，不重跑旧Run。失败目标保留旧选择；失败切换期间的输入明确未派发，不自动回退。closed仍不可重开，但blocked可明确结束并保留未知事实，结束不清除工作区隔离状态。

v3只允许带已关闭资源及有效交接来源证据的unknown历史在显式恢复后继续open。Store保留既有v1→v2→v3迁移，追加全事务v3→v4→v5→v6→v7→v8升级；nativeModel/nativeOptions与受管provider互斥，保留身份/历史/命令/事件与业务水位；blocked不自动重开。未知版本/损坏失败，不能用删库修复；回退旧程序需先停止服务并恢复升级前备份。

关闭等待在途create/validate（最多16个），验证finally清理完才允许释放Store。CLI stdin在readline之前2MiB原始字节守卫；stdout/每条记录与排队均16MiB限额，slow consumer明确停止而不无限缓存；退出时关闭自有输入handle。CLI consumer退出属于当前入口shutdown，不等于未来HTTP SSE订阅断开策略。

ADR-010初始切片未包含HTTP/图形UI与Provider；当前它们由ADR-011/012/013/014及[Provider与Web契约](provider-web-mvp.md)另行采纳。原生checkpoint、自动最优路由、任意工具权限覆盖或崩溃未知结果自动修复仍未实现。ADR-019新增原接口实际审批：请求归属当前Run，公开权限ID与原ID分离；决定先提交后回复，命令重试不重复回复，取消/关闭释放待决请求。transport提交不等于原生ACK。原生命令按已发现名称直接派发，不注入公共文本包；取消在命令目录读取后再次核实，不能派发已撤回命令。configHome仅私有目录引用；受管Provider使用固定revision与每轮私有配置。CLI默认控制执行30秒；生产Web原生执行300秒、请求10秒；完整可配置运行预算后续扩展，不把字节预算当模型token窗口证明。

ADR-020中，私有原生绑定按Harness/control归属，ready保存最后已同步的原生Run；后续只补该水位之后的公共事实。派发前先提交unconfirmed，结算/清理后才ready。未知或恢复失败不能fallback到空会话；显式重新建立保留旧引用与公共历史，不能称native_fork。所有权/归属、旧引用保留、游标和格式均受聚合校验。

ADR-022：原生活动作为Run事实提交。工具摘要（标题、状态、种类、名称、父工具、退出码）变化即提交，详情（输入16KiB、输出与差异各64KiB）在工具终态或回合结算后、绑定关闭前写入内容存储，Run只保存内容引用并记录`run.tool_detail`；计划（≤64项）、用量（本轮token、上下文占用、标注作用域的费用）、提示（≤32，同一对话中相同的提示只写日志不重复显示）、活动（子Agent/后台任务/压缩/重试/审查，≤64）与产物（内容引用或链接，≤32）同样有界。事件日志只含摘要和引用，不含预览或字节。内容存储位于数据根`content`目录，内容寻址、魔数判型、owner守卫；启动时回收超过7天且未被任何Run引用的内容。存储失败写诊断，不改变回合结论。

ADR-025：在已完成的回复后可分支为新Session：`origin`记录源对话、分支点与到该点为止的引用历史（不可变、不重新执行、1MiB上限），新Session同工作区与选择。只有源当前原生会话恰好同步到分支点时，新Session以`fork-pending`引用创建，Runner在其任何输入前用独立连接执行原生fork：先提交`forking`，确认后`ready`并保存副本引用；明确拒绝时归档并以公共历史继续；结果未知时保持`forking`并阻止原生使用。分支不向源对话写入事实；公共上下文以`branchedHistory`带上引用历史。

ADR-023：发送可带最多8个附件（单条合计32MiB），准入时同步确认它们是本工作区未撤回的上传且字节仍在，否则不建Run；附件是Run不可变的一部分，命令指纹包含附件id。原生会话打开后、派发前由Driver按代理与所开模型的输入能力检查，不接受时本输入以ATTACHMENT_UNSUPPORTED/ATTACHMENT_LIMIT失败，Session保持open；通过的附件复制为数据根内稳定只读副本交给Driver。公共上下文只列附件名称、类型与大小。

ADR-021：原生侧撤回仍待决的问题（如自身对话框到期）时，公开请求同步关闭并记录`permission.closed`（含原因），迟到回答明确拒绝。公开工具摘要每Run最多128项，超过后新工具不再追加，回合与Runtime不因此失败。原生连接预算为单帧16MiB、累计256MiB，会话建立请求最长60秒且不超过运行预算；没有进行中Turn的原生输出只计数，不归属到任何Run。
