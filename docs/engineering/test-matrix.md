# 计划测试矩阵

生成自 plan/test-cases.json。这是完整规划，不作为运行测试结果；planned/deferred 均不算通过。当前切片的实际测试另见验证记录，关联也不等于充分覆盖证明。

| 场景 | 所属任务 | 层 | 输入/交错 | 必须观察到的结果 | 状态 |
|---|---|---|---|---|---|
| V001-C01 | V001 | review | 候选Node/SDK/数据库/生成器版本及许可 | 记录精确版本、来源、许可证和兼容性，未知许可不默认放行 | planned |
| V001-C02 | V001 | probe | 不同Node patch运行同一安装与schema检查 | 不支持版本明确失败，结果可重复 | planned |
| V001-C03 | V001 | probe | 全新私有环境安装 | 不依赖开发者HOME/全局包或临时latest | planned |
| V002-C01 | V002 | probe | 固定二进制initialize及configOptions | 保存wire/SDK/模型/权限和取消的实际支持范围 | planned |
| V002-C02 | V002 | probe | 受控假上游一次prompt与权限拒绝 | 消息/工具/结束来源和拒绝真实可核对 | planned |
| V002-C03 | V002 | probe | 取消与后端退出 | 区分通知发送、prompt结束和资源清理，缺证据明确列出 | planned |
| V003-C01 | V003 | probe | 固定App Server thread/turn与schema | 不把原生Thread当公共Session，记录实验能力 | planned |
| V003-C02 | V003 | probe | 真实协议对假模型、审批和中断 | 识别最终turn状态及审批选项，不以ACK判成功 | planned |
| V003-C03 | V003 | probe | Provider变更或后端恢复不支持 | 明确重建或拒绝条件，不宣称热切换 | planned |
| V004-C01 | V004 | probe | 同一公共消息及成果渲染给A和B | 确认材料格式、角色、工具引用与能力边界 | planned |
| V004-C02 | V004 | probe | 超出窗口或包含秘密/不可信工具指令 | 明确拒绝或隔离，不静默截断或提权 | planned |
| V004-C03 | V004 | probe | A到B再回A的工作区变化 | 确定水位更新或重建要求，原生复用不能遗漏B的工作 | planned |
| V005-C01 | V005 | review | 消息/选择/切换/关闭的有效无效样例 | 身份、状态、错误、并发和幂等范围得到一致定义 | planned |
| V005-C02 | V005 | review | busy switch的wait/cancel和目标失败 | 冻结默认策略与生效边界，不保留含混兼容路径 | planned |
| V005-C03 | V005 | review | 两个切换与新消息交错 | 定义唯一待决意图或显式替换命令及顺序 | planned |
| V006-C01 | V006 | probe | POSIX后代脱离进程组及父进程先退出 | 明确可确认与未知归属的边界 | planned |
| V006-C02 | V006 | probe | Windows Job/breakaway与ACL宿主 | 在真实宿主记录结果，没有宿主标未验证 | deferred |
| V006-C03 | V006 | review | 发行平台和降级支持声明 | 不以macOS结果替代Windows，不支持的隔离明确拒绝 | planned |
| V007-C01 | V007 | review | 任务类别/能力/偏好与未知质量 | 冻结可解释规则与unknown处理，不编造最优分数 | planned |
| V007-C02 | V007 | review | 指定模式和无候选 | 拒绝原因清楚，指定目标不自动替换 | planned |
| V007-C03 | V007 | review | 评测保留集/预算/模型与停止原因 | 冻结可重复测量方案，实测前只声称策略适配 | planned |
| G001-C01 | G001 | integration | 干净检出安装与构建 | 固定版本可复现且不修改锁文件 | planned |
| G001-C02 | G001 | integration | 不支持的Node主版本与依赖漂移 | 必需检查非零拒绝 | planned |
| G001-C03 | G001 | security | 带真实开发者变量启动测试 | 变量和HOME隔离，秘密不被继承 | planned |
| G002-C01 | G002 | unit | Session/Turn/Attempt/Binding等不同ID | 不能互相替代，外部非法值被拒绝 | planned |
| G002-C02 | G002 | unit | 未知错误cause含凭据和路径 | 公开错误安全且保留内部归因 | planned |
| G002-C03 | G002 | property | 无效ID类型/Unicode/长度生成 | 边界与品牌类型不变量成立 | planned |
| G003-C01 | G003 | unit | declared/observed/validated与平台版本 | 证据等级不混淆 | planned |
| G003-C02 | G003 | unit | 缺证据的validated或未知能力 | 拒绝无依据支持声明 | planned |
| G003-C03 | G003 | property | 版本/能力组合与schema往返 | 生成类型与wire契约等价 | planned |
| G004-C01 | G004 | unit | auto/指定/模型独立选择和typed command | 语义区分且输入有界 | planned |
| G004-C02 | G004 | unit | 未知字段/空输入/边界字节/错误版本 | 明确字段错误，无静默默认 | planned |
| G004-C03 | G004 | property | 幂等等价输入与异输入 | 规范化hash和scope规则稳定 | planned |
| G005-C01 | G005 | unit | 执行/模型证据/产物/清理结果组合 | 不同结算面不合并成伪成功 | planned |
| G005-C02 | G005 | unit | 错误身份/旧generation/坏seq | 拒绝无归属事件 | planned |
| G005-C03 | G005 | property | 事件序列与schema升级 | 新增字段规则明确，未知必需事件不被吞掉 | planned |
| G006-C01 | G006 | unit | 消息/产物/策略/水位来源 | manifest完整可核对 | planned |
| G006-C02 | G006 | unit | 缺来源/坏hash/越界预算 | 不接受不可追溯材料 | planned |
| G006-C03 | G006 | security | 工具数据夹带命令或秘密 | 不能提升权限或泄露秘密 | planned |
| G007-C01 | G007 | unit | 事件/结果/取消/close独立入口 | 资源所有者与可等待关闭清楚 | planned |
| G007-C02 | G007 | unit | 不支持恢复/模型变更/权限覆盖 | 明确能力结果而非空fallback | planned |
| G007-C03 | G007 | unit | 第三方类型进入公共API | 边界检查可拒绝 | planned |
| G008-C01 | G008 | integration | 新库和受支持旧版本迁移 | 状态与迁移记录原子一致 | planned |
| G008-C02 | G008 | integration | 写入/提交失败或未知schema版本 | 回滚并明确失败，不清库 | planned |
| G008-C03 | G008 | integration | 两个活owner争用同一数据根 | 只有一个取得业务写入权 | planned |
| G008-C04 | G008 | integration | 提交前后进程崩溃 | 恢复数据与outbox一致 | planned |
| G009-C01 | G009 | security | 无令牌/错误角色/别人的Session | 拒绝管理与执行越权 | planned |
| G009-C02 | G009 | security | 跨站Origin/Host/DNS rebinding/CSRF | 不能借用本机身份 | planned |
| G009-C03 | G009 | integration | CLI与浏览器会话合法身份 | 相同权限范围访问相同应用命令 | planned |
| G009-C04 | G009 | security | 编码路径/未知method/Content-Type | 在分派前规范化拒绝 | planned |
| G010-C01 | G010 | security | 所属Provider/工具引用 | 仅授权边界取得所需值 | planned |
| G010-C02 | G010 | security | 缺秘密/坏权限/跨scope引用 | 明确拒绝且不打印原值 | planned |
| G010-C03 | G010 | platform | Keychain/DPAPI/文件后端 | 分别验证，不宣称同用户OS隔离 | planned |
| G010-C04 | G010 | security | 错误与日志含合成金丝雀 | 无原值泄露 | planned |
| G011-C01 | G011 | integration | 新增/完整替换注册 | 发布新revision并保留历史 | planned |
| G011-C02 | G011 | integration | 无效manifest/命令含秘密 | 提交前拒绝 | planned |
| G011-C03 | G011 | integration | 提交失败或并发expectedRevision | 内存目录不先更新 | planned |
| G012-C01 | G012 | integration | 受控PATH与安装目录 | 返回安装观察，不自动注册 | planned |
| G012-C02 | G012 | security | 恶意manifest/链接/相同ID | 拒绝歧义和越界 | planned |
| G012-C03 | G012 | integration | 缺Adapter或不可执行文件 | 明确原因，不联网下载或调用模型 | planned |
| G012-NC1 | G012 | integration | 由用户读取登录 shell 的 PATH 补充发现目录 | 只运行列在系统 shell 列表中的绝对路径 shell，用 -l -c 在首尾标记之间读取 PATH；只保留存在的绝对目录且去重；超过 3 秒、超过 64 KiB、没有标记或退出码非零都明确失败，登录配置留在进程组中的任务随之结束；经 HTTP 读取后只加入 Gateway 尚未搜索的目录，原先找不到的 Harness 被发现，用户移除目录后不再发现；未提供时 409；保存的目录重启后仍在，无法读取的文件当作没有 | planned |
| G012-NC2 | G012 | integration | web 命令集中决定是否提供读取登录 shell | 带 --no-login-shell、设置了 CI（即使为空）或在 Windows 上时不提供，否则使用 $SHELL（未设置时没有可读的 shell）；从正式 web 命令启动：不带参数时接口返回可读取，带 --no-login-shell 时返回不提供，帮助列出这个参数，拼错的参数在启动前被拒绝并以非零退出；带 --workspace-lock-root 时使用给定的租约目录 | planned |
| G013-C01 | G013 | protocol | 初始化宣告与受控探测结果 | 分别保存declared/observed证据 | planned |
| G013-C02 | G013 | protocol | 未公布可选方法/版本不匹配 | 不试探调用未支持能力 | planned |
| G013-C03 | G013 | integration | Harness或Adapter升级 | 旧validated不自动迁移 | planned |
| G014-C01 | G014 | integration | 活执行存在时drain | 新准入停止，旧执行仍归旧revision | planned |
| G014-C02 | G014 | integration | 重复drain与并发更新 | 幂等或显式冲突 | planned |
| G014-C03 | G014 | integration | 排空失败或超时 | 保留真实状态，不直接移除资源 | planned |
| G015-C01 | G015 | integration | 已排空且无活动引用 | 写移除标记，不删历史revision | planned |
| G015-C02 | G015 | integration | 活绑定或待决权限 | 拒绝或继续排空 | planned |
| G015-C03 | G015 | integration | 重启与旧文件重载 | 移除项不被自动复活 | planned |
| G016-C01 | G016 | integration | 协议/端点/模型和秘密引用 | 可按稳定身份选择 | planned |
| G016-C02 | G016 | security | URL内凭据/SSRF目标/坏模型声明 | 拒绝风险输入 | planned |
| G016-C03 | G016 | integration | 配置更新后历史计划 | 旧计划不被改写 | planned |
| G017-C01 | G017 | unit | 文件/环境/显式参数优先级 | 默认值在一处解析 | planned |
| G017-C02 | G017 | unit | 无效并发/超时/大小/未知字段 | 明确拒绝 | planned |
| G017-C03 | G017 | property | 精确上下界与时钟预算 | 不能用零值或溢出绕过限制 | planned |
| G018-C01 | G018 | integration | 合法创建和查询 | 公共ID独立于任何原生Harness | planned |
| G018-C02 | G018 | integration | 同key重试/异输入 | 同Session或冲突，无重复创建 | planned |
| G018-C03 | G018 | integration | 响应丢失后重启查询 | 状态与归属仍在 | planned |
| G019-C01 | G019 | integration | 文本与typed command | 消息/意图/期限/outbox同事务 | planned |
| G019-C02 | G019 | integration | 并发同key/异key/坏输入 | 稳定顺序和去重，非法不受理 | planned |
| G019-C03 | G019 | integration | 提交前后断连与崩溃 | 重复投递不重复副作用 | planned |
| G019-C04 | G019 | security | 未知命令或工具结果伪装命令 | 拒绝而不转成执行指令 | planned |
| G020-C01 | G020 | integration | 同Session并发发送与多Session | 同Session串行，跨Session有界并行 | planned |
| G020-C02 | G020 | integration | 队列长度/字节上限和队列期限 | 拒绝或超时，不无界累积 | planned |
| G020-C03 | G020 | property | 入队/取消/派发交错 | 最多一个有效执行槽位 | planned |
| G021-C01 | G021 | unit | 任务工具/权限/模型/平台与候选 | 仅满足全部约束者留下 | planned |
| G021-C02 | G021 | unit | 能力未知/停用/drain/不可导入上下文 | 排除且有原因 | planned |
| G021-C03 | G021 | property | 指定模式与无候选 | 不自动换目标或放宽约束 | planned |
| G022-C01 | G022 | unit | 相同输入策略和证据快照 | 排名可复放且并列稳定 | planned |
| G022-C02 | G022 | unit | 未知费用/质量/样本太少 | unknown不补零，不声称最优 | planned |
| G022-C03 | G022 | property | 候选顺序扰动与冷却状态 | 稳定tie-break与公平策略一致 | planned |
| G023-C01 | G023 | integration | 决策候选/排除/分数来源/目标 | 提交后可解释和复放 | planned |
| G023-C02 | G023 | integration | 决定后目标停用或变版 | 明确失败或新auto决策，不伪造旧选择 | planned |
| G023-C03 | G023 | integration | 保存失败 | 不启动未经持久记录的执行 | planned |
| G024-C01 | G024 | unit | 公共消息/目标/产物引用 | 来源、水位、预算与指纹完整 | deferred |
| G024-C02 | G024 | unit | 超限/摘要缺来源/旧水位 | 超限时分层并记省略账目；摘要缺来源或旧水位明确失败，不静默只取最近历史 | deferred |
| G024-C03 | G024 | security | 工具输出夹带指令/秘密 | 保持数据等级与秘密边界 | deferred |
| G025-C01 | G025 | integration | A到B再回A的文件与消息变化 | 复用必须同步，不足时显式重建 | deferred |
| G025-C02 | G025 | integration | manifest冻结后新消息/外部写入 | 不偷偷吸收新输入，冲突可见 | deferred |
| G025-C03 | G025 | property | 不同epoch/旧checkpoint/hash不符 | 不把空会话当恢复成功 | deferred |
| G026-C01 | G026 | integration | 两个Session同工作区竞争 | 同一时刻只有一个有效写者 | planned |
| G026-C02 | G026 | integration | owner崩溃/旧lease/迟到续租 | 代次隔离，不能只凭PID夺权 | planned |
| G026-C03 | G026 | platform | 外部程序写入或不支持强隔离 | 明确边界或拒绝强隔离要求 | planned |
| G027-C01 | G027 | property | 完成/失败/取消/期限全顺序交错 | 唯一终态且停止原因不被覆盖 | planned |
| G027-C02 | G027 | unit | 旧Attempt/epoch/generation事件 | 拒绝或隔离，不污染新执行 | planned |
| G027-C03 | G027 | integration | 终态与终止事件提交失败 | 原子回滚，不假报完成 | planned |
| G028-C01 | G028 | integration | outbox重复投递和响应丢失 | 同一意图只取得一次有效执行权 | planned |
| G028-C02 | G028 | integration | 派发前后Worker崩溃 | 未知结果不自动重跑 | planned |
| G028-C03 | G028 | integration | 准入失败或资源占用 | 有界排队且期限继续计时 | planned |
| G029-C01 | G029 | platform | 启动失败/流断裂/关闭stdin | 错误有归属并等待资源释放 | planned |
| G029-C02 | G029 | platform | 孙进程/脱离组/父先退出 | 按证据回收或unconfirmed，不能误杀他人 | planned |
| G029-C03 | G029 | platform | 取消启动中与强杀超时 | 升级终止和清理状态真实 | planned |
| G029-C04 | G029 | performance | 重复创建关闭与大stdout | 句柄/内存有界 | planned |
| G030-C01 | G030 | platform | Job内孙进程及主进程崩溃 | 整树归属与关闭可核验 | deferred |
| G030-C02 | G030 | platform | breakaway/已有Job/权限不足 | 显式失败或unconfirmed | deferred |
| G030-C03 | G030 | platform | 中文空格路径/cmd参数/启动中取消 | 原生行为正确，无窗口残留 | deferred |
| G031-C01 | G031 | protocol | 初始化/请求相关/通知 | 按wire v1与能力协商 | planned |
| G031-C02 | G031 | protocol | 分片UTF8/坏JSON/超大行/stdout污染 | 明确协议错误且关闭有界 | planned |
| G031-C03 | G031 | protocol | 断连/背压/迟到响应 | 相关请求结算，缓冲不无界 | planned |
| G032-C01 | G032 | protocol | prompt/update/tool/permission/result | 各事实关联正确Attempt与generation | planned |
| G032-C02 | G032 | protocol | cancel后late update与prompt结束 | 接受相关尾事件但不能影响下一执行 | planned |
| G032-C03 | G032 | protocol | 可选load/config未声明或恢复失败 | 明确拒绝，不空会话fallback | planned |
| G032-C04 | G032 | protocol | TCK通过/未覆盖/不适用 | 不把结果称官方认证 | planned |
| G033-C01 | G033 | protocol | 私有配置+模型网关+真实公布选项 | 请求经目标模型且不改用户文件 | planned |
| G033-C02 | G033 | protocol | 权限once/always/reject与未知选项 | 真实映射，不扩展许可 | planned |
| G033-C03 | G033 | protocol | 固定OpenCode通过ACP真实进程连接受控上游 | 验证Adapter协议、事件、权限和绑定清理；完整正式入口验收由G060承担 | planned |
| G034-C01 | G034 | protocol | initialize/thread/turn/item/approval | 原生ID与公共ID分离并正确相关 | planned |
| G034-C02 | G034 | protocol | interrupt ACK与最终turn状态 | 不以ACK或流末尾判完成 | planned |
| G034-C03 | G034 | protocol | 实验字段/坏schema/权限拒绝/恢复失败 | 明确失败或能力不支持 | planned |
| G034-C04 | G034 | protocol | 固定Codex二进制经原生协议连接受控上游 | 验证原生Adapter执行/中断/审批/绑定清理；完整正式入口验收由G060承担 | planned |
| G035-C01 | G035 | security | 活动Attempt请求所选模型 | 只允许所属epoch/generation与目标 | planned |
| G035-C02 | G035 | security | 旧token/跨Session/未活动/目标越权 | 拒绝且不泄露秘密 | planned |
| G035-C03 | G035 | integration | 结束/切换/重启 | 吊销或失效，不把Provider原Key交给Harness | planned |
| G036-C01 | G036 | protocol | 同协议流式文本与工具响应 | 语义保留，真实上游可核对 | planned |
| G036-C02 | G036 | protocol | 认证/限流/超时/流内错误 | 正确归因，不伪装成功 | planned |
| G036-C03 | G036 | protocol | 不可兼容媒体/结构字段 | 明确拒绝，不静默降级 | planned |
| G036-C04 | G036 | performance | 慢上游/慢读/大块 | 背压和缓冲上限成立 | planned |
| G037-C01 | G037 | integration | 每次模型调用和内部尝试 | 实际模型、用量来源与Attempt关联 | planned |
| G037-C02 | G037 | integration | Agent先结束但模型仍在途 | 等待取消/提交再结算 | planned |
| G037-C03 | G037 | integration | 未知价格/用量与账本写失败 | null/缺口或存储失败，不补零 | planned |
| G038-C01 | G038 | integration | 真实选项和单次决定 | 先提交再可发送，决定与applied分开 | planned |
| G038-C02 | G038 | integration | 同决定重试/冲突/过期/旧generation | 幂等或拒绝 | planned |
| G038-C03 | G038 | property | 权限与取消/期限/切换交错 | 旧决定不能授权新工具 | planned |
| G039-C01 | G039 | protocol | 后端应用ACK或明确拒绝 | 保存实际receipt，不推断工具成功 | planned |
| G039-C02 | G039 | integration | 决定已提交后Worker失联 | 状态未知，不向新绑定重发 | planned |
| G039-C03 | G039 | integration | 取消时仍有待决请求 | 按协议取消并收敛 | planned |
| G040-C01 | G040 | property | 排队/上下文/启动/权限/结算耗时 | 全部计入接收时预算 | planned |
| G040-C02 | G040 | unit | 单调时钟与系统时间跳变 | 不能延长或溢出预算 | planned |
| G040-C03 | G040 | integration | 期限与完成同时到达 | 规则唯一，清理grace独立 | planned |
| G041-C01 | G041 | integration | 排队/启动/运行/权限中取消 | 受理、后端结束、清理分别核对 | planned |
| G041-C02 | G041 | integration | 协议不响应或进程不退出 | 升级终止，未确认资源隔离 | planned |
| G041-C03 | G041 | property | 重复取消/旧generation/晚完成 | 不影响下一Attempt或覆盖停止原因 | planned |
| G042-C01 | G042 | integration | 稳定普通文件复制登记下载 | hash/大小一致且源后改不影响 | planned |
| G042-C02 | G042 | security | 链接/越界/设备文件/大小变化 | 拒绝并回收未登记对象 | planned |
| G042-C03 | G042 | integration | 缺文件/复制失败/取消采集 | 产物状态独立，不冒充任务正确 | planned |
| G043-C01 | G043 | integration | 执行证据/模型/产物/清理 | 分别展示，公共Session关联不变 | planned |
| G043-C02 | G043 | integration | 重复outbox和Interaction延迟 | 公共投影幂等且不提前释放执行权 | planned |
| G043-C03 | G043 | integration | 无调用/无输出/上游最终失败 | 不能仅凭exit0或Agent文本认定完成 | planned |
| G044-C01 | G044 | integration | 断线/重复/Last-Event-ID | 从持久水位追赶且去重 | planned |
| G044-C02 | G044 | integration | 游标过期/错误Session/未知事件 | 明确错误，不漏事件或从零偷重播 | planned |
| G044-C03 | G044 | performance | 慢客户端/高并发订阅 | 执行不阻塞、缓存有界且可关闭 | planned |
| G045-C01 | G045 | integration | 空闲A到B再回A | 固定manifest与实际selection，Session身份保持 | deferred |
| G045-C02 | G045 | integration | 目标准备失败/变版/drain | 实际选择不提前生效，公共事实保留 | deferred |
| G045-C03 | G045 | property | 两个请求和expectedVersion冲突 | 唯一待决意图，无最后写入偷覆盖 | deferred |
| G046-C01 | G046 | integration | 运行/权限/模型在途收到切换 | 按冻结策略等待或取消，结算后才交权 | deferred |
| G046-C02 | G046 | integration | 清理unconfirmed/资源被旧进程写 | blocked，不启动新写者 | deferred |
| G046-C03 | G046 | property | 切换/完成/期限/新消息交错 | epoch与水位唯一一致 | deferred |
| G046-C04 | G046 | integration | 提交生效前后崩溃 | 按事实恢复，不自动重跑上一输入 | deferred |
| G047-C01 | G047 | integration | 保持Harness只改Provider或模型 | 独立选择且实际调用目标正确 | planned |
| G047-C02 | G047 | protocol | 原生config支持与不支持 | 原地或显式重建，不声称全组合热切换 | planned |
| G047-C03 | G047 | integration | 模型变更失败与旧绑定已关闭 | 状态真实，公共Session不丢失 | planned |
| G048-C01 | G048 | integration | owner死亡/残留进程/未提交结果 | 核对后interrupted或隔离，不自动重跑 | planned |
| G048-C02 | G048 | integration | checkpoint不符/坏版本/丢材料 | 明确失败，不新建空会话装恢复 | planned |
| G048-C03 | G048 | integration | 执行已结束但公共投影未消费 | 幂等补齐已证明事实 | planned |
| G048-C04 | G048 | platform | PID复用/不同用户/不可见后代 | 不误杀，未知清理如实报告 | planned |
| G049-C01 | G049 | integration | close时有排队/运行/切换 | 拒绝新输入并按归属收敛 | planned |
| G049-C02 | G049 | integration | 重复close与后端失败 | 幂等并保留历史和清理状态 | planned |
| G049-C03 | G049 | integration | 关闭中重启 | 恢复已持久意图，不丢未知结果 | planned |
| G050-C01 | G050 | integration | 创建/消息/切换/关闭经真实服务 | 复用应用语义，202只表受理 | planned |
| G050-C02 | G050 | security | 未知字段/超大体/错误scope/过期版本 | 统一problem错误且无副作用 | planned |
| G050-C03 | G050 | integration | OpenAPI双向覆盖与生成漂移 | 遗漏/重复/过期内容能被拒绝 | planned |
| G051-C01 | G051 | integration | 取消/权限/查询/SSE/产物 | 状态与后台事实一致 | planned |
| G051-C02 | G051 | security | 旧attempt/跨Session/无身份 | 拒绝越权和迟到控制 | planned |
| G051-C03 | G051 | integration | 客户端断流和响应丢失 | 不取消执行或重新投递消息 | planned |
| G052-C01 | G052 | integration | SDK经正式HTTP提交查询控制 | 类型与错误语义一致 | planned |
| G052-C02 | G052 | integration | SSE断线和游标过期 | 只重连事件，不重发有副作用请求 | planned |
| G052-C03 | G052 | integration | 生成类型与契约变更 | 新鲜度及无效schema检查失败 | planned |
| G053-C01 | G053 | e2e | 文本/命令/权限与切换 | 调用同一SDK，用户无需厂商配置 | planned |
| G053-C02 | G053 | e2e | SIGINT/网络失败/未知命令 | 明确退出码与取消/查询，不私自重跑 | planned |
| G053-C03 | G053 | security | 命令输入或argv夹带秘密 | 不把值放进进程列表或日志 | planned |
| G054-C01 | G054 | e2e | 刷新/多轮/自动选择/手动切换 | 公共Session身份与历史保留 | planned |
| G054-C02 | G054 | e2e | requested与effective及失败 | 不提前展示新Harness已生效 | planned |
| G054-C03 | G054 | e2e | 窄屏/键盘/权限控件/断线 | 可操作且不持有独立业务状态 | planned |
| G055-C01 | G055 | e2e | 双Harness固定模型预算重复任务 | 正确性独立评分并记录不确定性 | planned |
| G055-C02 | G055 | e2e | 失败/超时/污染调参集 | 不以completed计质量，不混用保留集 | planned |
| G055-C03 | G055 | integration | 规则路由与固定默认比较 | 有来源的分任务报告，不能宣称绝对最佳 | planned |
| G056-C01 | G056 | e2e | A到B到A、只换模型、双换 | 公共上下文经接力送达可查，实际调用与成果连续可查 | planned |
| G056-C02 | G056 | e2e | 每个提交/ACK/切换水位故障点 | 无重复副作用或并发写，未知结果不重跑 | planned |
| G056-C03 | G056 | performance | 并发流/排队/慢客户端/长上下文 | 内存句柄有界，取消与切换延迟可测 | planned |
| G056-C04 | G056 | security | 提示注入/恶意工具/越权身份 | 不能改路由策略或提升权限 | planned |
| G057-C01 | G057 | integration | 按Session/Attempt/Switch导出 | 同一事实源含版本、水位和缺口 | planned |
| G057-C02 | G057 | security | 模型错误/工具正文/凭据金丝雀 | 默认诊断无秘密和原始正文泄露 | planned |
| G057-C03 | G057 | performance | 日志轮转/写失败/大量事件 | 有界且不伪造业务成功 | planned |
| G059-C01 | G059 | integration | 正式构建启动与关闭 | 端口注入、owner lease和资源等待完整 | planned |
| G059-C02 | G059 | integration | 没有可用Harness/Provider或初始化失败 | 服务状态明确，不演示fallback | planned |
| G059-C03 | G059 | integration | 第二个Adapter接入 | 核心业务入口不按厂商名称分支 | planned |
| G059-NC1 | G059 | integration | 工作区租约目录的默认值与显式指定 | 不指定时为每个本机用户共用的 /tmp/harnessgateway-workspaces-<uid>；显式目录必须是规范化的绝对路径，相对或含 .. 的路径在创建任何内容之前以 INVALID_INPUT 拒绝，不存在时以 0700 创建，权限对他人开放或是符号链接时以 INVALID_STORAGE 拒绝；使用同一目录的两个应用互斥同一工作区，使用另一目录的不互斥；chat 命令拒绝相对目录且不启动 Harness，sessions 与 web 命令使用给定的目录；测试一律使用自己的临时租约目录 | planned |
| G060-C01 | G060 | protocol | 固定ACP TCK与native协议客户端 | 记录通过/失败/未覆盖，不能称全协议认证 | planned |
| G060-C02 | G060 | platform | macOS/Linux/Windows原生进程与权限 | 平台证据独立，缺宿主不能算通过 | deferred |
| G060-C03 | G060 | e2e | 真实双Harness/双Provider权限文件恢复 | 指定版本组合验收，真实凭据不入仓库 | planned |
| G058-C01 | G058 | integration | 类型/schema/边界/测试/构建必需检查 | 失败或必需跳过返回非零 | planned |
| G058-C02 | G058 | integration | 故意无效边界/冲突所有权/缺证据 | 检查自身拒绝错误 | planned |
| G058-C03 | G058 | platform | 各发行平台缺签名/兼容记录 | 不发布未验证平台，设计通过不冒充发行通过 | deferred |
| G056-C05 | G056 | e2e | 取消与完成同屏障释放 | 终态唯一且停止原因不被晚完成覆盖 | planned |
| G056-C06 | G056 | e2e | deadline与permission允许同时到达 | 过期许可不再应用 | planned |
| G056-C07 | G056 | e2e | busy switch与close同时到达 | 不能在关闭后启动目标 | planned |
| G056-C08 | G056 | e2e | 目标Harness在decision和dispatch间drain | 新准入拒绝或记录新决策 | planned |
| G056-C09 | G056 | e2e | 模型Provider在context和绑定准备间被停用 | 不改用其他Provider | planned |
| G056-C10 | G056 | e2e | old Worker在epoch变更后发工具/权限 | 不能影响新执行 | planned |
| G056-C11 | G056 | e2e | model call完成但ledger提交失败 | 不能报告证据完整 | planned |
| G056-C12 | G056 | e2e | 文件采集期间被链接替换 | 拒绝越界和不稳定成果 | planned |
| G056-C13 | G056 | e2e | outbox提交成功但客户端ACK丢失 | 同key重送返回同意图 | planned |
| G056-C14 | G056 | e2e | 切换effective提交后响应丢失 | 按SwitchId查询生效事实 | planned |
| G056-C15 | G056 | e2e | 工作区租约到期但旧进程仍活 | 新写者阻塞 | planned |
| G056-C16 | G056 | e2e | 恢复时PID被其他进程复用 | 不误杀且报告归属未知 | planned |
| G056-C17 | G056 | e2e | SSE心跳与持久event交错 | 心跳不推进持久游标 | planned |
| G056-C18 | G056 | e2e | 恢复历史游标超出保留期 | 明确410及历史入口 | planned |
| G056-C19 | G056 | e2e | 大UTF8字符跨协议块分片 | 不损坏内容且受字节上限约束 | planned |
| G056-C20 | G056 | e2e | 输入幂等记录被清理后旧请求重放 | 不假称仍有去重保证 | planned |
| G056-C21 | G056 | e2e | A原生绑定仍在但B改变目标文件 | A不能用旧水位继续写 | planned |
| G056-C22 | G056 | e2e | 权限决定已落库但后端失联 | applied保持未知，不投递新绑定 | planned |
| G056-C23 | G056 | e2e | 未定价模型与成本预算约束 | 明确不可核算规则，不当作免费 | planned |
| G056-C24 | G056 | e2e | 模型断开时Agent仍正常退出 | 执行证据缺口真实显示 | planned |
| G020-C04 | G020 | property | 取消/close先提交、旧启动outbox首次投递 | 已撤销ExecutionGrant/tombstone拒绝启动，同epoch不能放行 | planned |
| G028-C04 | G028 | integration | start authorization与取消在派发前交错 | 持久控制顺序唯一，旧Worker不能用过时controlSeq启动 | planned |
| G008-C05 | G008 | integration | 旧owner暂停超过TTL后恢复 | 排他锁仍阻止接管，TTL不能授予第二owner | planned |
| G048-C05 | G048 | platform | 锁异常释放但旧owner仍存活或身份未知 | 拒绝新owner接管，旧代次不得更新或派发 | planned |
| G048-C06 | G048 | integration | 新owner推进generation后旧Worker或权限回调到达 | 拒绝旧代次控制并在新写者前确认旧资源静止 | planned |
| C001-C01 | C001 | review | 不同公共ID与错误scope的有效/无效样例 | 身份不可互换，错误结构/脱敏/版本规则明确 | planned |
| C001-C02 | C001 | review | 错误含原生cause或秘密 | 公开字段不泄露，内部归因可保留 | planned |
| C001-C03 | C001 | review | 缺字段/未知字段/边界长度 | schema拒绝样例与参考值可机器验证 | planned |
| C002-C01 | C002 | review | 平台/版本/证据等级组合 | 声明/观察/验证明确分开 | planned |
| C002-C02 | C002 | review | 无来源validated或未公布能力 | 无效声明被拒绝 | planned |
| C002-C03 | C002 | review | 停用/排空/移除与旧revision引用 | 新准入和历史引用边界固定 | planned |
| C003-C01 | C003 | review | 创建/消息/typed command/切换/close样例 | 输入、幂等、版本、控制顺序与错误精确定义 | planned |
| C003-C02 | C003 | review | 同epoch已取消Turn的旧启动意图 | tombstone和Grant版本校验有字段支持 | planned |
| C003-C03 | C003 | review | auto/指定/模型独立选择 | 偏好与实际生效选择分开 | planned |
| C004-C01 | C004 | review | ExecutionGrant/controlSeq/ownerGeneration | 签发、撤销、授权和迟到控制有闭合集合 | planned |
| C004-C02 | C004 | review | 取消/期限/完成/未知结果组合 | 唯一终态与各结算面可完整表达 | planned |
| C004-C03 | C004 | review | 授权前后崩溃或owner变化 | 未知派发不重跑，旧授权不可再用 | planned |
| C005-C01 | C005 | review | 持久event与临时delta/心跳 | 只有持久事实推进公共seq | planned |
| C005-C02 | C005 | review | 重复/过期游标和版本演进 | 重放去重、410和未知事件处理明确 | planned |
| C005-C03 | C005 | review | 巨大正文与原生payload | 大小边界、产物引用和脱敏责任明确 | planned |
| C006-C01 | C006 | review | 交接单清单 `RelayPacket` 与送达行 `DeliveryRecord` 的 S1 样例对照 JSON Schema 与终稿第 4 节 | 清单样例与 Schema 一致，所有枚举集中在第 4 节声明 | planned |
| C006-C02 | C006 | review | 缺引用/旧摘要/坏hash/超限 | 缺引用、旧摘要、坏 hash → 不进入执行；超限 → 分层并记省略账目，只有最小交接单 + 当前原话超限才 `RELAY_INPUT_LIMIT` | planned |
| C006-C03 | C006 | review | A到B到A与工具历史 | 旧原生状态不冒充最新公共上下文 | planned |
| C007-C01 | C007 | review | 候选/硬约束/unknown/策略版本 | 决策来源与质量不确定性可解释 | planned |
| C007-C02 | C007 | review | 指定目标不可用或无候选 | 不能静默替换或放宽约束 | planned |
| C007-C03 | C007 | review | 决定和执行间配置改变 | 固定计划与准入复核有明确身份 | planned |
| C008-C01 | C008 | review | 事件/结果/取消/关闭和恢复等级 | 端口行为、时序、失败和资源责任有实例 | planned |
| C008-C02 | C008 | review | 原生权限或取消无法保证 | 能力不支持或未知状态可以表达 | planned |
| C008-C03 | C008 | review | Grant/owner fencing与派发相关 | 旧意图和旧代次不能获得新的外部作用 | planned |
| C009-C01 | C009 | review | Session/执行/权限/产物/管理全部操作 | 统一operationId、身份、错误、响应和媒体类型 | planned |
| C009-C02 | C009 | review | 遗漏/重复操作或失效schema引用 | 静态契约检查能够拒绝 | planned |
| C009-C03 | C009 | review | SSE与202及幂等/条件请求 | 生成客户端不会误解受理/完成与流媒体 | planned |
| C010-C01 | C010 | review | Provider端点/协议/模型/秘密引用 | 资源与执行选择独立，公开数据没有秘密 | planned |
| C010-C02 | C010 | review | 不支持协议/URL内凭据/未知模型 | 输入与能力失败精确定义 | planned |
| C010-C03 | C010 | review | 调用身份/实际模型/未知用量费用 | 证据字段及null语义明确 | planned |
| V008-C01 | V008 | review | 精确schemas/错误/样例/状态转换/许可版本 | G1证据在应用实现之前存在 | planned |
| V008-C02 | V008 | review | 依赖/所有权/运行窗口与门禁审计 | 严重矛盾关闭并留评审记录 | planned |
| V008-C03 | V008 | review | 未验证能力或缺宿主 | 限制支持范围，不能伪造已验证 | planned |
| G061-C01 | G061 | integration | 查询/注册/检查/排空/移除经正式HTTP | 操作复用Catalog服务且管理身份正确 | planned |
| G061-C02 | G061 | integration | 无角色/坏revision/活引用/重复请求 | 明确拒绝或幂等，不绕过排空规则 | planned |
| G061-C03 | G061 | integration | 管理变更与已有Session并行 | 旧执行保留版本，新准入遵循新状态 | planned |
| G062-C01 | G062 | integration | Provider登记查询与秘密引用经HTTP | 复用模型资源服务且不泄露凭据 | planned |
| G062-C02 | G062 | integration | 无身份/越权/坏端点/未知模型 | 提交前拒绝且错误脱敏 | planned |
| G062-C03 | G062 | integration | Provider更新与执行计划并行 | 不悄悄改写已接收选择或历史计划 | planned |
| G056-C25 | G056 | integration | 工具/模型在途时注入磁盘满或commit失败，再提交输入和权限 | 新输入明确失败；无新Grant/模型/工具/权限派发；旧资源取消或隔离；未落库终态不被假报 | planned |
| G056-C26 | G056 | integration | 存储恢复后对账仍活或未知的旧Attempt | 只应用可证明事实，不自动重跑；清理未确认继续阻塞写权 | planned |
| G060-C04 | G060 | e2e | 正式G059入口驱动固定OpenCode完成模型/权限/文件/取消链路 | 真实HTTP/Store/IPC/原生进程与产物/清理完整可核对 | planned |
| G060-C05 | G060 | e2e | 正式G059入口驱动固定Codex完成模型/审批/文件/中断链路 | 真实HTTP/Store/IPC/原生进程与产物/清理完整可核对 | planned |
| G063-C01 | G063 | integration | 合法上下文/Adapter/组合根依赖 | 合法依赖与发布类型通过 | planned |
| G063-C02 | G063 | integration | 领域导入SDK/HTTP/SQLite/子进程或泄露第三方类型 | 静态门禁拒绝错误且有定位 | planned |
| G063-C03 | G063 | integration | 漏扫描目录或工具吞错 | 必需检查非零退出，不虚构覆盖 | planned |
| G063-C04 | G063 | integration | 测试隔离静态规则：组合应用或启动 Gateway 的测试没有使用自己的临时租约目录（workspaceLockRoot 或 --workspace-lock-root，ADR-041） | 检查以非零退出并指出文件；使用临时租约目录的测试通过；检查纳入 pnpm check，漏扫描目录不算通过 | planned |
| V008-C04 | V008 | review | 所有核心ADR及其契约/版本/验证引用 | accepted有来源与范围、索引与独立文件一致、未决项明确阻塞 | planned |
| V008-C05 | V008 | review | 核心ADR仍proposed、缺独立记录或缺验证证据 | G1保持关闭，不能凭计划结构通过自动采纳设计 | planned |
| G008-P01 | G008 | integration | 合法v1快照编号升级到v2 | 身份、commands/create_key、事件序号和业务version完全保留 | planned |
| G008-P02 | G008 | integration | 后一个legacy快照损坏导致迁移失败 | 所有先前row与user_version原子回滚，不清库 | planned |
| G016-P01 | G016 | unit | 协议/URL/models/default/key/target严格输入与精确边界 | 拒绝未知字段、错误类型、超限、重复模型和无所属模型 | planned |
| G016-P02 | G016 | integration | 不可变revision/CAS/幂等与密钥rotate或保留 | 旧revision不变，冲突拒绝，密钥不进明文metadata | planned |
| G016-P03 | G016 | integration | 真实SQLite/vault故障、links、损坏与事务中止 | 身份、大小、GCM和关系拒绝；metadata/key/command整事务回滚 | planned |
| G016-P04 | G016 | security | 模型probe错误/redirect/超限/断连/关闭与流式分片密钥 | 有界失败，无诊断泄密；关闭等待probe；每个分片位置过滤key | planned |
| G047-P01 | G047 | probe | 真实Codex运行中编辑A，静止切换B再切换新A | 确证恰好3个本地请求的endpoint/model/key/history及pinned旧revision | planned |
| G050-P01 | G050 | security | Host/Origin/cookie/CSRF/一次token/UTF8/超限并发与静态路径 | 正式HTTP明确拒绝非法访问，资源有界，不返回秘密 | planned |
| G050-P02 | G050 | integration | 真实HTTP+SQLite+Driver/IPC的对话切换取消断轮询与重开 | 各公共事实可读，幂等不重派，失败目标不回退，协议未知阻塞 | planned |
| G054-P01 | G054 | e2e | 真实浏览器新增编辑probe启停Provider，chat switch/reload/cancel | 页面操作使用正式HTTP/SQLite/IPC且实际state一致，无console错误或key泄漏 | planned |
| G054-P02 | G054 | e2e | 桌面/手机/320宽键盘与IME界面检查 | 无横向溢出，输入键盘语义正确，unsupported组合有明确解释 | planned |
| G060-P01 | G060 | probe | 真实Gemini受管API-key/Gemini协议私有配置与文本分片脱敏 | 核对真实HTTP路径/model/key/公共输入与历史/唯一请求和cleanup；外部模型仍本地确定性夹具 | planned |
| G060-P02 | G060 | probe | 真实Codex→Gemini→Codex同Session双本地Provider的跨协议上下文接续 | 核对真实HTTP路径/model/key/公共输入与历史/唯一请求和cleanup；外部模型仍本地确定性夹具 | planned |
| G011-M01 | G011 | unit | 管理输入/持久状态/安装身份与字段严格校验 | 拒绝未知状态/字段/无效ID/类型/路径/预算，不信任泛型JSON断言 | planned |
| G011-M02 | G011 | integration | 真实SQLite命令幂等/CAS/日志/全量恢复与默认指针损坏 | queued取消、active未知不重跑；缺或坏事实拒绝；旧默认不被替换 | planned |
| G029-M01 | G029 | security | 真实gzip/bzip2/ZIP解包、合法内部链接与越界路径/类型 | 安全格式可解包，traversal/绝对/链接逃逸/特殊文件拒绝 | planned |
| G029-M02 | G029 | integration | 真实外部安装进程与TERM/KILL/输出/父退出子孙 | 资源关闭独立确认，stdout/stderr分离，预算/取消/cleanup错误不冒充成功 | planned |
| G029-M03 | G029 | integration | Gateway 以 umask 077 运行时启动安装、升级、卸载程序 | 程序按终端的 umask 022 运行，新建文件 0644、目录 0755；找不到或不可执行的程序仍是 PROCESS_START_FAILED；取消仍结束整个进程组 | planned |
| G061-M01 | G061 | integration | 正式HTTP提交/取消/日志/checkupdates/真实管理与Driver升级 | 命令冲突409，安装后发现，V1运行中升级V2不改V1，下轮用V2 | planned |
| G061-M02 | G061 | security | Owner inode被替换时关闭服务 | 即使持久Owner失败，自己拥有的安装PID也必须被清理并报告OwnerLost | planned |
| G061-M03 | G061 | integration | 系统PATH与已发布受管版本同时存在、显式override阻塞 | 优先managed；明确override不fallback；不执行任何发现的程序 | planned |
| G060-M01 | G060 | probe | 官方npm真实Codex0.160私有安装再升级0.162.1并实际两轮调用 | 新旧目录独立、旧字节不变、SRI匹配、actual安装事件/完整历史/cleanup准确；模型仍本地模拟 | planned |
| G054-M01 | G054 | e2e | 新版搜索品牌选择器/模型切换/安装升级日志与响应丢失 | 真UI/HTTP/SQLite/进程，条件按真实状态，幂等不重复；桌面/小屏无溢出、reduced-motion | planned |
| G011-M03 | G011 | integration | 系统包版本观察与明确检查时的有界版本探测 | 已观察package无需启动；native/Node入口分开；未知/期限/预算/取消/owner丢失有真实进程证据 | planned |
| G011-M04 | G011 | integration | 已检查最新版本之后安装/升级与重开缓存比较 | 默认版本变化后可更新状态重新派生，checking/failed保持事实；相同已安装版显示current | planned |
| G061-S02 | G061 | integration | 真实HTTP/SSE已提交首块先于完成、断连与重连事实恢复 | 无命令重派发；身份/水位、连接/背压/心跳/关闭有界；网络错误不取消Run | planned |
| G061-S01 | G061 | unit | UTF8/SSE字节分片、协议预算、取消及canonical消息投影 | 任意合法分片保持文本；错身份/水位/半帧明确失败；旧消息不追加重复 | planned |
| G054-S01 | G054 | e2e | 真实生产UI逐段显示、生成中取消、重载续接、Markdown和阅读滚动 | 输出在后端结束前可见；停止保留部分文本；编辑只填草稿；IME/窄屏/reducedmotion保持 | planned |
| G001-S01 | G001 | unit | 工程文档扫描与根运行数据/第三方安装文档分离 | 忽略根data/artifacts，但docs/data坏链接仍拒绝，必需检查非零失败 | planned |
| G061-S03 | G061 | unit | 已接收命令的ACK正文断流、写请求期限与错误归属 | 正文transport失败不接受半JSON；business4xx保留；错session/不完整receipt拒绝；写请求不无限挂起 | planned |
| G060-S01 | G060 | e2e | 真实Codex/私有模型配置/正式HTTP事实流在本地模型未完成前输出首块 | 真实Harness与DB/HTTP/Driver；首文本先于模型及Run终态；断线恢复不重复派发，最终原文完整且cleanup独立确认 | planned |
| G028-R01 | G028 | integration | 启动或目标切换失败且已关闭，不阻塞同Session后续显式输入 | 原选择保留，等待失败切换的输入不误发，其他Session继续执行 | planned |
| G028-R02 | G028 | integration | 未知执行的显式恢复与不可信清理拒绝 | 同Session新epoch；unknown终态不改写，旧队列不重跑，清理/owner/pub故障拒绝 | planned |
| G008-R01 | G008 | integration | v2到v3的真实SQLite升级和损坏回滚 | 身份/历史/命令/事件字节保持；blocked不自动重开；坏数据整笔回滚 | planned |
| G050-R01 | G050 | integration | 认证HTTP恢复旧误阻塞会话与幂等/无效输入 | 202对应新switch，验证无prompt，CSRF与不安全恢复拒绝 | planned |
| G031-R01 | G031 | protocol | Gateway认证缺失分类、RPC业务拒绝和清理证据分离 | 已知错误有稳定码，凭据不反射；explicit rejection为failed，close仍独立确认 | planned |
| G031-NC1 | G031 | protocol | 从进程表找出离开进程组的后代 | 从组内成员按父进程向下最多 32 层，取进程组不同的后代及其启动时间与命令基名（不含参数与路径，路径含空格也能取出）；组内没有成员时为无法枚举；没有离开的后代时为 0；无法解析的进程表为无法枚举 | planned |
| G054-R01 | G054 | e2e | 失败Harness选择后原对话可用、重试和草稿/结束确认 | 同Session继续，未知不一键重跑，往返/刷新草稿保留，结束需明确选择 | planned |
| G061-N01 | G061 | integration | 本机原生配置继承、模型发现/选择及认证HTTP投影 | 真实进程接收原配置与原生模型RPC；无prompt发现、错误模型拒绝、DTO无凭据、查询和取消边界 | planned |
| G008-N01 | G008 | integration | v3到v4真实SQLite升级及历史水位不变 | 保留身份/消息/Run/命令/事件；新字段仅v4允许，损坏拒绝且不清库 | planned |
| G054-N01 | G054 | e2e | 读取所选Harness原生模型、直接切换与快速连续改选 | 无Apply，最新意图最终生效，输入仅发往有效目标，同Session历史保留，小屏重试不竖排 | planned |
| G032-L01 | G032 | protocol | OpenClaw早到初始化信息与普通Gateway会话键 | 元数据确认后核验身份，错身份/过量/早到输出拒绝；按JSON5配置选择默认agent及规范会话键 | planned |
| G061-L01 | G061 | integration | 原PATH入口优先于已存在的私有副本 | 缺失可用已有本地副本；原入口和坏显式覆盖不被替代，多控制需要明确选择 | planned |
| G011-L01 | G011 | integration | 真实版本与来源、拒绝把替代副本当系统升级 | 实际本机版本保持权威，已安装系统项拒绝未实现的原生升级，不改私有默认遮蔽原安装 | planned |
| G054-L01 | G054 | e2e | 全部Harness品牌SVG实际加载与原生选择流程 | 每行品牌图标加载成功，当前原生切换、窄屏、草稿、停止和重连保持 | planned |
| G011-N01 | G011 | integration | 正式HTTP本机npm原位置升级与全局配置写保护反例 | 原程序版本可核对；保护写入被拒绝，未知安装明确核实且不重跑 | planned |
| G011-N02 | G011 | integration | 管理库v1迁移与未知维护/活动用户互斥 | 旧任务保留，无效新表迁移回滚；维护不覆盖活动程序 | planned |
| G032-N01 | G032 | protocol | Pi原CLI运行时模型覆盖与重试/静止/取消 | 不写set_model；等到agent_settled后结算，取消/清理分开 | planned |
| G032-N02 | G032 | protocol | 原生认证/额度失败与未知远端文本 | 投影明确失败类别而不泄露远端秘密 | planned |
| G061-N02 | G061 | integration | Claude未设置配置目录与显式用户路径 | 保留未设置状态以读取原登录；显式用户目录正常沿用 | planned |
| G011-N03 | G011 | unit | 原生回执/计划路径、全局安装位置与冻结npm版本元数据 | 缺少版本/配置证据不得完成，路径/包/其他程序bin被拒绝；原npm/uv位置被保留，安装与版本验证都保护配置 | planned |
| G011-NC1 | G011 | unit | 能力矩阵的 Harness 分层与目录的分层一致（原“判断本机版本是否为真实验证过的版本”，版本部分 2026-10-22 随 ADR-053 删除） | 能力矩阵为每个 Harness 记的分层与目录的 harnessTier 一致，冻结的恰为 Cursor、Gemini CLI、Pi；任一处单独改动都使测试失败。不再有任何版本判断：已验证版本表、semver 区间比较与四处对账由第三批 D1 删除，版本只作矩阵 installation 文本与验收记录里的证据 | planned |
| G011-NC2 | G011 | unit | 在原程序中继续的命令按产品给出，与安装版本无关（ADR-053 决定 3） | Claude Code、Codex、OpenCode、Hermes 对任何已安装版本都给出交互命令与一次性命令（函数没有版本输入，对任何安装、含读不出版本的，都给出同样的命令）；DeepSeek Harness 只给一次性命令（官网包没有 tui profile）并附凭据前提说明 onceNote（headless 只读终端环境的 DEEPSEEK_API_KEY、工作区 .env 或 ~/.dsh/.env）；OpenCode 的两种形式旁附产品线说明 onceNote（OpenCode 2 对它没有的会话 ID 会新建会话而不是报错，OpenCode 1 会报错；不读版本号）；Pi 只指向它的会话列表；OpenClaw 不给；没有续接命令的产品（Cursor、Gemini CLI）只给 ID 且 note 为 no-command，不再有 version-unverified；含空格、引号、分号、$( 或以 - 开头等非普通标识符的引用既不显示也不进入命令；Codex 只问一次的形式只在工作区不是 Git 仓库时带 --skip-git-repo-check 并注明原因，交互形式从不带；读取不触发发现与版本探测 | planned |
| G060-N04 | G060 | platform | 原Homebrew创建并认证继承沙箱，模型配置与Homebrew仓库拒绝写入 | 真实SDK继承成立；配置与brew自身写入以明确EPERM拒绝且原内容不变，进程退出可等待 | planned |
| G061-X01 | G061 | integration | 原生快切换不启动额外进程、目录缓存刷新/失效、命令与实际审批决定幂等 | 真实HTTP/SQLite/IPC保持；未知原生选项不派发、原生命令不注入文本包、取消目录读取后不派发、审批先提交再响应且重试不重发 | planned |
| G008-X02 | G008 | integration | 公共历史v4到v5及无效原生设置迁移回滚 | 历史/消息/事件不变，所有行和版本原子升级或全部回滚 | planned |
| G032-X03 | G032 | protocol | Pi原生输入、选择、编辑与确认交互 | 真实RPC实际字段回传，不继续静默取消，关闭释放待决交互 | planned |
| G008-NC1 | G008 | integration | 原生绑定恢复、待确认和归属保护；旧v5事务升级到v6及无效回滚 | 正式存储/IPC和原生身份保留；无效或未知明确拒绝，无自动fallback；输入/恢复并不冒充后端达标 | planned |
| G028-NC2 | G028 | integration | 原生进程重开、A→B→A增量历史、重启、未知拒绝恢复及显式重建 | 正式存储/IPC和原生身份保留；无效或未知明确拒绝，无自动fallback；输入/恢复并不冒充后端达标 | planned |
| G034-NC3 | G034 | protocol | ACP恢复回放、Codex历史用量不绑定新Turn、Pi原文件恢复和原生问答 | 正式存储/IPC和原生身份保留；无效或未知明确拒绝，无自动fallback；输入/恢复并不冒充后端达标 | planned |
| G032-NC4 | G032 | protocol | ACP迟到/自主输出、未归属权限请求、重复或未宣告工具id、多行标题、列表外模型值、非文本块、load后回放 | 归一化且绝不归属到其他Run；迟到权限以cancelled应答；连接不中断；回放不进入新回复 | planned |
| G032-NC5 | G032 | protocol | Pi0.85.1编辑器prefill/value、带timeout对话框、扩展命令无运行、terminate结束、档位来源；Cursor全局模型写 | 按原生字段往返；到期撤回问题且拒绝迟到回答；按原生状态结算；不加载Pi内部JS；Cursor模型只读且不发送set_config_option | planned |
| G034-NC4 | G034 | protocol | app-server附着的子Agent/外部线程通知与审批、类型化codexErrorInfo失败 | 外部线程输出不归属；子线程审批交给用户；无关线程审批decline；失败按类型分类 | planned |
| G028-NC3 | G028 | integration | 原生撤回待决问题；单回合工具数超过公开摘要预算 | permission.closed先提交、迟到回答拒绝；超出预算不失败、Runtime不进入致命状态 | planned |
| G060-NC1 | G060 | e2e | 本机原安装跨Hub owner重启的原生恢复与只读目录审计 | 真实原程序回复来自恢复的原生上下文、sourceRunIds为空、回放不混入、原模型配置不变；目录审计不发提示词并确认清理 | planned |
| G008-NC2 | G008 | integration | 原生产物与工具详情的内容寻址存储：按字节判型、保留期回收、半写文件、外来标记、异常文件与失效owner | 相同字节只存一份；伪装图片与SVG只作文件；只回收无引用且过期的记录；外来或不一致存储与失效owner明确失败 | planned |
| G008-NC3 | G008 | integration | v6事务升级到v7；运行中的内容引用集合 | 原会话、原生绑定与Run保留；未知版本明确拒绝；被引用内容不被回收 | planned |
| G028-NC4 | G028 | integration | 原生工具详情、计划、用量、提示、活动与非文本产物进入公开Run；超大预览；同会话重复启动提示 | 摘要先提交，详情在终态或结算前存储且日志只含引用；存储失败可见；重复提示只进日志不重复显示 | planned |
| G032-NC6 | G032 | protocol | ACP工具详情（rawInput/rawOutput/diff/locations）、计划、usage_update与回合用量、通知、压缩、非文本块；未宣告的客户端方法 | 按真实字段有界映射；未宣告方法回-32601并留审计行，不改变回合结果 | planned |
| G032-NC7 | G032 | protocol | Pi工具参数、流式与最终结果、patch差异、逐消息用量与上下文窗口、压缩与自动重试、扩展通知与错误 | 工具详情与差异可读；用量按回合累计；活动与提示不打断回合 | planned |
| G034-NC5 | G034 | protocol | Codex item细节（命令、补丁、MCP、搜索、图片、子Agent）、增量输出节流、turn/plan/updated、tokenUsage基线、警告与改路由 | 命令输出与退出码、补丁差异与计划按协议字段映射；历史累计用量不计入本轮；提示与活动不改变回合结果 | planned |
| G050-NC1 | G050 | integration | 内容读取路由GET/HEAD、下载与内联类型白名单、CSP与nosniff；SSE run帧 | 只读访问、未知内容404、不可内联类型强制下载；run帧只携带活动Run的已提交原生活动 | planned |
| G054-NC1 | G054 | e2e | 统一聊天显示原生计划、提示、工具详情（差异着色）与本轮用量 | 只显示已提交事实；工具详情按需读取；刷新后与服务端一致 | planned |
| G061-NC1 | G061 | unit | 客户端校验SSE run帧 | 只替换活动Run的原生活动，缺失事实时要求完整快照 | planned |
| G060-NC2 | G060 | e2e | 本机原安装真实工具回合：命令与编辑；工作区级审批配置；计划工具 | 文件真实被修改；工具摘要与详情已存储可读；审批只允许一次；原全局配置不变；未出现的能力如实记录而非通过 | planned |
| G004-NC1 | G004 | unit | v7输入附件引用：数量、字节、唯一性、规范字段与准入后不可变 | 超限、重复、空列表、非规范或v6中的附件明确拒绝；已受理输入的附件不能被替换 | planned |
| G008-NC4 | G008 | integration | 上传按命令幂等暂存、按字节判型、按工作区准入、撤回，以及稳定只读副本与回收 | 同命令同内容返回同一引用；类型不符、长度不符与超限拒绝且不留半写；其他工作区与原生产物不可作为附件；副本被改动时恢复；无引用过期内容与副本一并回收 | planned |
| G028-NC5 | G028 | integration | 附件随输入准入、派发前检查并复制；Driver拒绝附件 | 未知或外工作区附件不建Run；拒绝发生在派发前，本输入failed且Session保持open、无unknown；原生消息只收到准入的副本 | planned |
| G032-NC8 | G032 | protocol | ACP附件内容块（图片、音频、嵌入文本、文件链接）；OpenClaw 5 MB与模型输入门控；OpenCode按原CLI模型目录细化 | 按代理声明映射且未声明能力派发前拒绝；拒绝信息只含附件名；模型目录不可用时退回代理级声明 | planned |
| G032-NC9 | G032 | protocol | Pi图片附件与文件路径；按Model.input门控 | 仅声明图片的模型收到images；文件以只读副本路径写入提示；文本模型派发前拒绝图片 | planned |
| G034-NC6 | G034 | protocol | Codex localImage/localAudio与文件路径；按所开模型inputModalities门控 | 图片与音频以只读副本路径交给原程序；文件写入文本；模型未列出的输入派发前拒绝 | planned |
| G050-NC2 | G050 | integration | 原始字节上传、撤回与带附件发送；CSRF、长度、类型不符 | 上传绑定本工作区且幂等；撤回后不能再随消息发送；无效请求明确拒绝且不建Run | planned |
| G054-NC2 | G054 | e2e | 统一聊天添加附件、标记不受支持的附件、刷新后保留草稿附件并在消息中显示 | 不受支持或未就绪附件阻止发送；草稿附件随会话草稿恢复；发送后消息显示图片与可下载文件 | planned |
| G060-NC3 | G060 | e2e | 本机原安装真实附件：只存在于附件中的代码、纯色图片；未声明图片的模型 | 回复包含附件独有的事实；未声明图片的模型在派发前明确拒绝；原全局配置不变 | planned |
| G034-NC7 | G034 | protocol | Codex线程审批策略与沙箱设置；/compact原生压缩回合；/export读取rollout记录 | 设置只取自原配置并由线程回报核实，未应用即失败；压缩回合按通知绑定且不发turn/start；无rollout记录时明确失败 | planned |
| G032-NC10 | G032 | protocol | Pi /compact（RPC compact与扩展同名命令优先）与 /export（export_html） | 无同名扩展时调用原生压缩并显示前后token；扩展命令按原样发送；空会话导出明确失败 | planned |
| G032-NC11 | G032 | protocol | ACP目录读取与代理命令公告的竞态 | 命令公告到达即结束等待；从不公告的代理只等待一次有限时间 | planned |
| G050-NC3 | G050 | integration | 公开对话导出为Markdown或JSON | 需要登录；只含公开事实与摘要，不含原生私有绑定；用户文本中的围栏不能截断引用；格式无效明确拒绝 | planned |
| G054-NC3 | G054 | e2e | 对话头部导出菜单 | 导出链接下载公开对话，附件以名称列出 | planned |
| G060-NC4 | G060 | e2e | 本机原安装经统一命令执行原生压缩与导出 | 压缩由原程序执行且之后仍记得先前事实；导出返回原程序自己的记录；仅使用目录列出的命令；原全局配置不变 | planned |
| G004-NC2 | G004 | unit | v8分支来源与原生fork引用的状态 | 来源历史有界且不可变；fork引用只能沿待派发→派发→就绪或归档推进，缺来源或越级即拒绝 | planned |
| G008-NC5 | G008 | integration | v7事务升级到v8；v7数据中出现分支来源 | 原会话与事件保留；v8专属字段出现在v7数据中整笔拒绝 | planned |
| G028-NC6 | G028 | integration | 从最新回复分支（原生fork）、从更早回复分支（公共历史）、原生拒绝fork | 分支引用原生副本且源会话不变；更早位置不做原生fork而带上引用历史；拒绝时归档引用并以公共历史继续；同命令返回同一分支 | planned |
| G034-NC8 | G034 | protocol | Codex thread/fork及fork连接上的线程通知 | 返回新线程身份；源线程与副本的通知只计数不归属；拒绝报告为不可用 | planned |
| G032-NC12 | G032 | protocol | ACP session/fork的声明要求与复制历史回放 | 未声明即不可用；回放计数不归属；fork连接不能再打开会话 | planned |
| G032-NC13 | G032 | protocol | Pi恢复源会话文件后clone | 返回独立的新会话文件与身份；扩展取消时不可用 | planned |
| G050-NC4 | G050 | integration | HTTP分支路由与分支会话的第一条输入 | 没有完成的回复时拒绝；返回带引用历史的新会话且命令幂等；第一条输入带上引用历史 | planned |
| G054-NC4 | G054 | e2e | 从回复分支、分支来源显示与回到原对话 | 分支打开并显示引用历史和原生状态；分支在原生副本继续，原对话仍在原线程 | planned |
| G060-NC5 | G060 | e2e | 本机原安装真实分支：原生fork或公共历史回退与隔离 | 分支答出源会话记住的标记；只告诉分支的事实不进入源会话；不能fork的Harness如实回退；原全局配置不变 | planned |
| G034-NC9 | G034 | protocol | Codex技能、MCP状态与已安装插件列表；/skill:名称调用；无skills/list的旧版本 | 只列出原接口报告的条目并有界；启用技能以Codex自己的skill输入调用，停用技能不调用；旧版本无技能而不失败 | planned |
| G032-NC14 | G032 | protocol | Pi命令目录中的技能与扩展来源 | skill:名称列为技能，扩展按来源文件去重；无MCP | planned |
| G050-NC5 | G050 | integration | 按需读取原生扩展的HTTP路由 | 需要登录；Codex接口返回列表，ACP接口返回null；未知参数拒绝 | planned |
| G050-NC6 | G050 | integration | 按回合读取诊断信息 | 服务端现场拼装不保存；植入stderr的路径与sk-令牌不出现；默认不含对话内容，勾选后只含该轮提示词与回复；参数无效400、回合不存在404、未登录401 | planned |
| G050-NC7 | G050 | integration | 导出已取消的回合时说明原因 | Markdown 导出与界面一致：执行预算用尽、等待你的决定超时、用户停止分别写出，不都写成已停止 | planned |
| G050-NC8 | G050 | integration | 按需读取在原程序中继续的信息 | 未登录 401；原生会话建立前为 null；之后返回原生会话 ID 与未验证说明；会话视图与 JSON 导出不含这个 ID；多余的查询参数 400 | planned |
| G061-NC6 | G061 | integration | 待处理列表的按需读取与推送 | 有对话打开时随该对话的流推送且不移动会话游标；没有对话时单独订阅；只推送更新的修订；慢订阅者在排空后只收到最新列表；按需读取不会吞掉一次推送 | planned |
| G054-NC5 | G054 | e2e | 原生扩展面板与技能调用 | 只读显示技能、MCP与插件；选择技能填入命令并由原程序以技能处理 | planned |
| G060-NC6 | G060 | e2e | 本机原安装的原生扩展列表与工作区技能调用 | 列表来自原安装；只在测试工作区定义的技能经命令真实调用；需信任的Harness如实记录未加载；原全局配置不变 | planned |
| G032-NC15 | G032 | protocol | OpenClaw回合按本会话原生转录对账：工具与结果、思考、逐次用量与真实停止原因 | 只取本回合追加的转录；桥报告end_turn但转录为error时回合失败并分类；转录不可读时保持桥的结果并留诊断 | planned |
| G060-NC7 | G060 | e2e | OpenClaw本机原安装只读工具回合 | exec工具及结果在回合后出现并可读；用量记录；原配置不变 | planned |
| G004-NC3 | G004 | unit | v9原生引用记录原生会话回报的模型与选项；同一选择纪元内被原生改动的已选值在下一回合沿用 | 回报有界校验、v8数据中出现即拒绝；只沿用已选键；纪元变化、受管Provider、未回报模型、未改动值或无已完成回合时不沿用；只有拥有该原生会话的Run可写入 | planned |
| G008-NC6 | G008 | integration | 业务库v8到v9迁移 | v8会话全部事实与事件不变，仅版本升为9；v8数据中出现回报配置时整笔拒绝且版本保持8 | planned |
| G028-NC7 | G028 | integration | 原生配置回报不可读或无效时视为未知 | 回合结果不受影响；记录native.config_unreadable；清除旧回报；下一回合按选择应用 | planned |
| G032-NC16 | G032 | protocol | ACP按代理宣告报告当前配置；OpenClaw回合后经原CLI读回会话设置 | ACP未回显的模式按已应用值记录；OpenClaw按会话行与chat.history映射桥的选项ID，回合前不报告；恢复的会话按会话行模型检查图片，无会话行时按配置模型 | planned |
| G032-NC17 | G032 | protocol | Pi回合后报告自己的模型与思考档位，恢复的会话保留上次运行的模型 | get_state映射为目录ID；未选择模型时恢复不强加默认模型；有选择时仍以选择为准；无会话时拒绝 | planned |
| G061-NC2 | G061 | integration | 正式HTTP入口下原生命令改设置后的同步 | 下一回合应用原生值并提交native.config_carried；视图含observed与carried且不含私有引用；同选择显式切换后按选择应用 | planned |
| G054-NC6 | G054 | e2e | 输入框显示原生命令改动的设置并可改用所选设置 | 提示列出被沿用的设置；高级配置显示原生当前值；改用所选设置后提示消失并按选择执行；窄屏不溢出 | planned |
| G060-NC8 | G060 | e2e | 本机原安装中原生命令改设置后的下一回合 | 首轮按选择；原生命令改动后读回新值；下一回合沿用不改回；同选择显式切换后恢复；原配置不变 | planned |
| G004-NC4 | G004 | unit | v9接续的原生会话来源：有界引用历史、标题与完整性，并保留导入时的原生引用 | 非v9、缺少该Harness的原生引用、标题含控制字符、未读历史却有引用或声称完整、负数省略、未知字段、来源中的分支字段、接续来源下的fork引用均拒绝；来源不可变 | planned |
| G008-NC7 | G008 | integration | 按原生引用查找持有它的会话 | 只计ready与unconfirmed引用；归档引用与分支待建的引用不算持有；按Harness控制入口区分 | planned |
| G008-NC8 | G008 | integration | 业务库v10与v11升级到v12 | 会话全部事实与事件不变，仅版本升为12；v10数据中出现保留进程、v11数据中出现进程组身份时整笔拒绝且版本保持不变 | planned |
| G028-NC8 | G028 | integration | 把本机原生会话接续为新对话 | 最近消息在预算内引用并计入省略数；同命令重放不再读取；同键不同请求拒绝；同一原生会话不能被第二个对话持有；下一条输入直接发给原生会话且不带公共上下文；不能读取历史时不引用；工厂不支持或标识非法时拒绝 | planned |
| G028-NC9 | G028 | integration | 服务被强制结束后，新的服务接管上一服务保留的原生进程 | 按进程组号与组长启动时间识别；确认结束（含原程序已自行结束）后才释放该对话的工作区租约，并在对话中记录结果，下一回合重新启动原程序并恢复原生会话；没有身份时不发任何信号，租约保持隔离，下一回合为WORKSPACE_QUARANTINED | planned |
| G028-NC10 | G028 | integration | 跨对话列出等待用户的审批与提问及其期限 | 运行时按自身时钟把驱动给出的剩余等待换算为期限并标明来源；只列出未决定的请求，不含标题与详情；决定后即移除；等待预算先到时请求记为 expired（原程序收到取消，不会收到批准）、加“等待期限已到”提示、回合以 WAIT_EXPIRED 结算为已取消；重启后的服务不列出上一服务遗留的请求，排队等待工作区的回合记为中断、不再排队 | planned |
| G028-NC11 | G028 | integration | 不同工作区的对话有界并行，同一工作区可见排队 | 上限内同时执行，满额时空位按受理先后分配；同一工作区的回合排队并记录 run.waiting（持有者、持有者是否在等用户），持有者的回合结束后自动开始并记录 run.waiting_ended；排队中可按回合取消，其他排队者按受理先后取得工作区；等待工作区超过等待预算时以 WORKSPACE_BUSY 结束、从未派发、不重试并记录持有者；所有位置已满时回合等待空位并记录 run.waiting（kind slot，带正在执行的数量），可以按回合取消且不启动程序；取消正在等待的回合后，等待立即转给同一对话的下一条消息，只有那一条会到期 | planned |
| G028-NC12 | G028 | integration | 执行预算与等待预算由运行时计时 | 执行预算从派发起算，等待用户时暂停（ACP、Codex、Pi 各一）；执行预算到期加“执行期限已到”提示并走停止链，宽限内结算为已取消（RUN_TIMEOUT），原程序不结束时宽限后强制结束并记为未知；进入与离开等待记为事件，业务格式不变；预算参数只接受范围内的整数（执行30至3600秒、等待1至120分钟），其他值在服务启动前以 INVALID_INPUT 失败；停止原因判定后，原程序在宽限内晚到的完成不改写它：回合仍为已取消（RUN_TIMEOUT），原程序的结果单独记录 | planned |
| G028-NC13 | G028 | integration | 关闭或接管保留进程时记录离开进程组的后台任务 | 结束组前枚举一次，结束后按进程号与启动时间复查：用户结束与服务重启接管都在证据中记录找到与仍在运行的数量和命令基名；不向它们发信号；仍在运行时对话提示一次，下一回合后消失；组长已退出或没有记录的组身份时记为无法枚举，组长仍在而没有离开的后代时记为 0 | planned |
| G032-NC18 | G032 | protocol | ACP按session/list列出本工作区会话并经session/load回放读取历史 | 只列本工作区；跨页查找；回放的用户与代理文本合并为消息，思考与工具不计入；不发送提示；未声明列表的代理与OpenClaw明确不可用 | planned |
| G034-NC10 | G034 | protocol | Codex按thread/list列出本工作区线程并按thread/turns/list读取历史 | 排除其他工作区与临时线程；标题取名称或预览；从新到旧分页读取后按时间排列，图片以占位表示；其他工作区与临时线程拒绝；不恢复线程、不发送任何回合 | planned |
| G061-NC3 | G061 | integration | 正式HTTP入口列出并接续本机会话 | 列表分页；接续后视图含来源与就绪原生状态且不含私有引用；列表标出持有它的对话；重复接续409、其他工作区404；侧栏标题“接续 · 标题”；下一条消息以原会话load后原样发送 | planned |
| G054-NC7 | G054 | e2e | 输入框的本机会话面板接续会话 | 列表可加载更早会话；接续后显示来源块与可展开历史并可继续对话；已接续的会话显示“打开对话”；窄屏不溢出 | planned |
| G060-NC9 | G060 | e2e | 本机原安装在新工作区自建的会话被Hub列出并接续 | 原程序自己创建的会话被列出；接续引用含标记；第二次接续因占用拒绝；接续后回答出只有原生会话知道的标记且未注入公共上下文；原配置不变 | planned |
| G061-NC4 | G061 | integration | ACP审批显示请求中的工具差异或命令 | 正式入口的审批请求带工具标题与将要修改的统一差异；决定仍按原选项ID往返 | planned |
| G010-NC1 | G010 | unit | 审批请求的标题、详情与选项名经凭据脱敏 | 注入凭据不出现在公开的审批事件中；审批ID保持原值 | planned |
| G010-NC2 | G010 | unit | 诊断文本的清洗与拼装 | 先经既有脱敏器，再隐去路径、环境变量值、密钥样式字符串与账户名，保留其余文字与行；首行说明是否含对话内容；stderr只留最后4 KiB；总量不超过64 KiB；默认不含提示词与回复 | planned |
| G061-NC5 | G061 | unit | 工具按列出的父调用分组显示 | 父调用在列表中时归到其下；自指、缺失父调用与成环的平铺；超过三层的挂在第三层祖先下，每个工具只出现一次 | planned |
| G054-NC8 | G054 | e2e | 子 Agent 运行的工具显示在子 Agent 调用之下 | 子 Agent 调用显示工具数；嵌套列表含子工具并可展开详情；窄屏不溢出 | planned |
| G054-NC9 | G054 | e2e | 侧栏标记等待处理的对话并按期限倒计时 | 侧栏说明等待审批或提问、期限来源与剩余时间，每秒更新，到期即消失；点击只打开对话，决定在对话内完成；浏览器通知由用户开启，只在页面不可见时发出，只含 Harness 名称与剩余时间 | planned |
| G054-NC10 | G054 | e2e | 从执行详情复制诊断信息 | 默认不勾选对话内容，复制的首行与内容一致，不含私有路径；勾选后含该轮提示词 | planned |
| G054-NC11 | G054 | e2e | 排队回合显示等待的对话与原因 | 审批卡与侧栏显示“等待期限 · 剩余 N 分”；同一工作区的第二个对话显示“排队中：等待对话「…」释放工作区（它正在等待你的审批／它正在运行）”和剩余等待，不含路径；可取消排队、可打开那个对话，批准后排队回合自动完成；排队到期显示消息没有发出、占用它的对话和“打开那个对话”；4 个对话占满位置时第 5 个显示“等待开始：4 个对话正在执行”和“没有单独的等待期限”，可以取消；用户停止的回合显示“已取消（用户停止）” | planned |
| G054-NC12 | G054 | e2e | 任意版本都不显示版本提示（原“未经验证的版本在 Harness 列表与选择器中提示”，2026-10-22 按 ADR-053 反转） | 安装任意版本（读不出版本、预发布版、比真实验收记录更新或更旧的版本）后，Harness 列表、选择器、欢迎页与详情只显示版本号、接入口版本与渠道最新版本，页面任何位置都不出现“未经验证”“未核实”“相隔约”“还没有验证”这类按版本号推断的提示；预发布版只作中性事实写出，不用警示色；仍可选择与发送 | planned |
| G054-NC13 | G054 | e2e | 执行配置显示原生会话与在原程序中继续 | 打开执行配置后显示原生会话 ID 与复制按钮；任何版本（包括读不出版本的安装）都给出该产品的续接命令与复制按钮，不出现“未在此版本验证”或“已用真实回合验证”字样；只有没有续接命令的产品只显示 ID | planned |
| G054-NC14 | G054 | e2e | 结束保留进程后提示仍在运行的组外后台任务 | 结束后台进程后输入框下方说明“原程序的后台任务可能仍在运行（N 个进程）”，发送下一条消息后消失 | planned |
| G054-NC15 | G054 | e2e | Harnesses 页从登录 shell 补充搜索目录 | 面板说明会执行 shell 登录配置，并写明只运行列在 /etc/shells 中的 shell、其他 shell 会被拒绝；只在点击时读取；读取后列出新增目录并可逐项移除，移除后说明没有带来新的目录；shell 不在列表中时显示拒绝原因，目录不变 | planned |
| G060-NC10 | G060 | e2e | 本机原安装把命令委派给自己的子 Agent | 子 Agent 调用与其运行的工具被提交并关联；主回复不混入子 Agent 输出；原配置不变 | planned |
| G032-NC19 | G032 | protocol | ACP原生表单（elicitation/create）逐字段提问 | 初始化声明elicitation.form；单选、自填（Other伴随字段并入提交回答）、多选按列表返回、是否题；跳过即decline、取消即cancel；含数字等无法显示的字段整表拒绝并提示；非交互时拒绝 | planned |
| G060-NC11 | G060 | e2e | 本机原安装用自己的提问工具向用户提问 | 问题以对话中的原生提问显示；选择第二个选项后原程序按该回答回复；原配置不变 | planned |
| G032-NC20 | G032 | protocol | Claude /export 复制本会话的 Claude Code 转录作为产物 | 代理没有自己的export命令时目录提供Hub的/export；按claude-agent-acp相同的位置查找转录并只读复制；找不到时明确失败；不发送提示 | planned |
| G060-NC12 | G060 | e2e | 本机原安装的思考输出与回复分开记录 | 需要思考的设置下Run记录原程序的思考内容且不混入回复，答案正确；原配置不变 | planned |
| G034-NC11 | G034 | protocol | Codex子Agent线程的工具嵌套在子Agent条目之下 | 子线程由thread/started、subAgentActivity或协作调用的receiverThreadIds识别；子线程工具以子Agent条目为父，最终回复作为条目输出，回合结束更新状态；孙线程嵌套在子线程下；无关线程不显示；子线程文字不进入回复 | planned |
| G032-NC21 | G032 | protocol | OpenClaw按Gateway只读报告列出技能与插件 | 技能来自skills.status（可用性含资格、停用与白名单），插件来自tools.catalog的插件工具组；不列MCP；只请求只读方法 | planned |
| G032-NC22 | G032 | protocol | Hermes 的 /export 运行它自己的会话导出 | Hermes 没有自己的 export 命令时提供 /export；只运行一次 sessions export - --session-id <id>，会话的 JSON 行作为产物登记；未知会话的提示句、超过 8 MiB、超过 5 秒都明确失败且不记录部分内容；非普通标识符不调用命令行；不向模型发送任何内容 | planned |
| G032-NC23 | G032 | protocol | 驱动从自己 Agent 的通知读出的登录状态成为目录的就绪状态（Claude 的 _auth/status_update） | 通用 ACP 层给子类扩展通知钩子与就绪状态设定，不按 Harness 分支；Claude 报告具名身份（account、api_key、external、gateway）为已就绪，none、缺失、未知或畸形的报告为未说明，从不判为未登录、不拒绝会话；label、detail、account 不保存、不记录、不显示；其他 ACP Agent 的同名通知仍是一条只写方法名的未支持通知诊断，就绪状态不变 | planned |
| G032-NC24 | G032 | protocol | OpenCode 的 /compact：ACP 命令目录未列出时由 Hub 补入，不看版本（ADR-053 决定 5） | OpenCode 的命令目录未列出 compact 时，无论 initialize 报告什么版本（1.19.0、1.17.9、读不出版本、本地构建）都追加 /compact 并按输入原样转发，开始语不变；目录已列出 compact 时不重复补入（无效样例）；其他 ACP Harness 的目录不补入；/compact 回合以 end_turn 结束却没有任何回复、工具或活动事件时结果为 failed、error.code 为 NATIVE_COMMAND_IGNORED 并说明“OpenCode 没有执行 /compact”，不算成功；回合有回复文本时为 completed（1.18.35 的真实形状，docs/verification/opencode-compact-2026-10-22.md） | planned |
| G060-NC13 | G060 | e2e | 本机原安装应用所选原生设置并执行原生命令 | 回合后原生回报与所选设置一致，限制修改的模式下文件不变；原生命令作为独立回合执行并产生预期文件；原配置不变 | planned |
| G054-FR1 | G054 | e2e | 侧栏按状态分组，跨对话收件箱 | 等你处理与进行中的对话排在最前；铃铛列出所有对话中等待的审批与提问，写明期限来源与剩余时间，点击打开对应对话；通知开关在收件箱中，默认关闭 | planned |
| G054-FR2 | G054 | e2e | 过程折叠为一行摘要并可切换密度 | 简洁模式下每轮工具折叠为一行摘要，失败与未完成的数量写在摘要里；切到详细后全部展开，偏好在重新载入后保留 | planned |
| G054-FR3 | G054 | e2e | 详情栏的改动、过程、计划、后台与执行 | 改动按文件列出工具报告的差异且只读；执行页列出执行者、模型连接、阶段耗时与用量，并可复制诊断信息；窄屏时详情栏以抽屉或底部面板打开 | planned |
| G054-FR4 | G054 | e2e | 回复进行中暂存下一条消息 | 本轮正常结束后自动发出一次且只由暂存它的标签页发出；本轮失败、取消、切换待生效或页面重新载入时放回输入框不发出；发出前可编辑或撤回 | planned |
| G054-FR5 | G054 | e2e | 命令面板与快捷键 | ⌘K 打开命令面板，可搜索对话、前往页面、切换主题与过程显示，Enter 执行；⌘/ 打开快捷键表；⇧⌘O 新建对话；输入法组合中不执行 | planned |
| G054-FR6 | G054 | e2e | 明暗主题与减少动效 | 设置中可选跟随系统、浅色、深色；深色下主要页面在 390 与 320 像素宽度没有横向滚动；减少动效时动画与过渡不超过 1 毫秒 | planned |
| G054-FR7 | G054 | unit | 统一差异解析与过程摘要 | 差异按文件拆分并给出行号与增删计数，无文件头时使用工具报告的位置；摘要按工具类别计数并始终写出失败与未完成数量 | planned |
| G054-FR8 | G054 | e2e | 审批卡片的数字键 | 卡片获得焦点时 1–9 选择对应的一次性选项；会长期生效的选项不绑定数字键；焦点在卡片内输入框时数字键照常输入 | planned |
| G011-UP1 | G011 | unit | 识别使用一个本机安装的程序，并判定重启后的服务是否恢复 | 按 launchctl、ps、lsof 的真实输出逐字段解析，不读任务的环境变量块；程序或前几个参数落在安装里的 launchd 任务是它的服务，配方声明的进程名是常驻程序，命令行指向安装的是其他程序，本进程及其后代和只共享前缀的路径不算；非 macOS 不读服务；重启后要新进程、running、自重启只启动一次且连续 5 秒不变，声明了端口的在 60 秒内监听过才算就绪，否则写未就绪；已停止的服务不启动，被拒绝的重启与取消如实失败 | planned |
| G011-UP2 | G011 | integration | 升级前检查与用户同意后的重启 | 检查只读：列出随升级重启的服务及命令原文、不重启的常驻服务及其自己的重启命令、HarnessHub 的空闲对话、旧记录与退回命令，不重启也不关闭任何东西；同意后关闭空闲进程、安装并核实版本，随后立即只重启同意过的服务一次并记录新进程与端口监听，其他服务继续运行；v3 任务事实原样读回 | planned |
| G011-UP3 | G011 | integration | 需要重启却没有同意的升级 | 在关闭空闲进程和安装之前停下：SERVICE_CONSENT_REQUIRED，未派发，原版本不变，没有重启任何服务 | planned |
| G011-UP4 | G011 | integration | 正在使用程序的 HarnessHub 对话、另一个 HarnessHub 进程与旧记录 | 正在回复的对话阻止升级且不关闭空闲对话；另一个进程持有的使用租约阻止升级且什么都不改；写记录的进程已结束的旧记录在维护锁内清除并逐条写日志 | planned |
| G011-UP5 | G011 | integration | 新版本已核实但服务没有重新运行 | 任务失败并记下已安装版本、原配置保留与每个服务的结果；错误给出重试命令与退回命令；不回滚不重试，维护锁按已知结果释放 | planned |
| G011-UP6 | G011 | integration | 兼容校验的隔离沙箱 | 只能写本次临时目录：写真实配置路径被拒绝（EPERM），连接本机正在监听的端口失败且对方没有收到连接 | planned |
| G011-UP7 | G011 | integration | 管理库 v3 手工降级到 v2 | 文档中的 SQL 保留每个任务，只去掉 v3 新增的五个事实字段并把 user_version 改回 2，剩下的字段正是 v2 读取器接受的集合；本构建再打开时重新标为 v3 | planned |
| G011-UP8 | G011 | integration | 新版本要求的 Node.js 与运行程序或被重启服务的不一致 | 升级前检查列出程序 #! 解释器与每个以 Node.js 启动的服务各自的版本、路径与是否被重启，Homebrew 的 Node.js 给出 brew upgrade 命令；程序或被重启服务不满足时升级在改动前以 RUNTIME_INCOMPATIBLE 停下并指名是哪一个，不关闭空闲进程、不重启服务、原版本不变；不重启的服务只提示 | planned |
| G028-UP1 | G028 | integration | 升级关闭保留进程 | 只关闭该 Harness 的空闲保留进程，按正常停止链记录原因 harness_upgrade，经存储解析器读回；对话在下一回合前可得知是升级关闭了它；排队或运行中的回合算作正在使用 | planned |
| G054-UP1 | G054 | e2e | 升级确认框与没有升级的任务 | 点升级先检查再确认：列出会重启的服务和命令、仍用旧版的程序、会关闭的对话、插件、产品说明与退回命令（不再有版本跨度与未验证提示，ADR-053）；有对话正在回复、另一个 HarnessHub 进程、程序或被重启服务的 Node.js 不符时不能确认，不重启服务的 Node.js 不符只提示；提交的同意与指纹来自这次检查；改动前停下的任务显示没有升级与原版本，不显示核实版本与空日志，旧版本的拒绝按实际情况解释 | planned |
| G054-UP2 | G054 | e2e | 升级关闭了对话保留的进程 | 输入框上方与详情栏后台页说明是升级关闭了它，下一回合开始后消失；事件记录原因 harness_upgrade | planned |
| G012-OC1 | G012 | unit | 按产品官网写明的 macOS 安装渠道判定找到的程序是否算已安装 | npm 全局包在任意前缀（Homebrew 的 Node.js、nvm 等）下算；Homebrew formula 与 cask 先于 npm 识别；官方脚本按其目录或启动器加目录内程序识别；pnpm、bun 全局的官方包识别为不维护的渠道；源码目录、npm link、同名其他包、无关 keg、项目自己的依赖、只共享前缀的目录不算；适配器按其注册表包或归档识别；9 个产品的渠道都登记了官网来源和日期 | planned |
| G012-OC2 | G012 | unit | 官网策略下的发现：非官网程序单独列出，PATH 默认不是官网时选用后面的官网安装 | official 下官方渠道外的程序移到 unofficial，不算已安装、控制入口缺失；any 下照常可用并标注渠道为空；PATH 默认是非官网时选用搜索顺序中第一份官网安装并记录渠道、版本与角色；PATH 默认损坏时什么都不选；发现清单的显式入口保留；包目录回退也按渠道判定 | planned |
| G012-OC3 | G012 | integration | 正式入口的 Harness 列表与新建对话只认官网安装 | 经 startWebServer 读取：nvm 下 npm 安装的 Pi 算已安装并列出渠道、版本与当前使用，PATH 上更靠前的源码链接只作为不带路径的说明；只有源码链接的 DeepSeek Harness 显示未安装并给出官网安装命令；9 个产品都有官网安装命令；列表字段不含私有路径；新建对话在 official 下绑定 Pi、拒绝 DeepSeek Harness，any 下两者都可绑定 | planned |
| G012-OC4 | G012 | integration | discover 默认只认官网安装，--allow-unofficial 只用于开发 | 默认 JSON 把 PATH 上的非官网程序列入 unofficial、控制入口缺失，文本输出写“只发现非官网安装，平台不使用”；--allow-unofficial 时它是渠道为空的候选、控制入口可用 | planned |
| G054-OC1 | G054 | e2e | Harness 详情列出每份官网安装与当前使用，非官网安装只作说明 | 详情按顺序列出渠道、接入口、当前使用与版本，pnpm 安装注明不维护；多份产品安装时说明当前使用指 HarnessHub 环境的 PATH；非官网说明按是否已有官网安装、是否在 PATH 上措辞；未安装时给出官网安装命令；无页面错误 | planned |
| G011-UN1 | G011 | integration | 脚本渠道的卸载按安装脚本写入的白名单删除 | Claude Code、Codex、Cursor、OpenCode、Hermes 各删安装脚本写入的链接、启动器、文件和目录；指向别处的链接和用户自己的启动脚本保留并说明；目录是链接或上级目录经链接指向别处时拒绝；计划读出后安装变了就不删；用户数据不动；白名单都是家目录下的普通相对路径，且不含产品数据目录 | planned |
| G011-UN2 | G011 | integration | 管理库 v4 保存卸载任务与冻结目标，降级脚本回到 v3 | v4 读取卸载任务和它的事实；未核实删除的完成、带安装版本的卸载、非卸载任务带卸载事实都被拒绝；降级脚本删除卸载任务、日志和目标表，保留其他任务，本构建能再打开 | planned |
| G011-UN3 | G011 | integration | 卸载的检查、同意与阻止 | 检查列出产品服务及其停止命令（路径以 ~ 书写）、保留数据、卸载后改用哪一份；没同意停止的服务不卸载；确认后安装变了拒绝；正在回复的对话阻止；先停服务后删程序，空闲进程先关闭；常驻程序和未声明的服务阻止且不动任何东西；开始删除后失败为结果未知，核实只记录现状不重跑；pnpm 安装不提供卸载 | planned |
| G011-UN4 | G011 | integration | 经正式 Gateway 入口按渠道真实卸载 | 临时 npm 前缀里由 npm 自己安装的包用 npm 卸载，临时家目录里的脚本安装按白名单删除；确认与日志不含家目录绝对路径和环境变量值；用户数据不变；同一命令重复提交返回同一任务，已卸载的安装再提交返回 404 | planned |
| G011-UN5 | G011 | unit | 隐私检查找出确认内容中家目录的绝对路径 | 以 ~ 书写的路径和系统路径通过；任何字符串或对象键中出现的家目录绝对路径（单独、在命令里、在赋值里）都被找出；其他用户的同前缀目录不算 | planned |
| G011-UN6 | G011 | unit | 卸载请求的字段 | 卸载必须带安装引用和确认的指纹，服务列表排序且不重复；安装引用必须是 64 位十六进制而不是路径；卸载不接受升级的字段，其他动作不接受卸载的字段 | planned |
| G054-UN1 | G054 | e2e | 卸载确认框 | 常驻程序在运行时说明并禁止确认；否则列出先停止的服务及命令和影响、关闭的空闲进程、删除的命令和文件、保留的数据、仍在运行的其他程序和卸载后的状态；提交的内容正好是确认框显示的同意；任务显示为等待卸载；无页面错误 | planned |
| G011-UN7 | G011 | unit | 按名字启动的原生程序靠它打开的可执行文件找到 | 命令行里没有路径的进程，凭 lsof 报告它打开了这份安装的程序文件而列入“仍在运行”；本进程及其后代不列；不存在的程序文件不去查询 | planned |
| G011-IN1 | G011 | unit | 安装脚本只经 HTTPS、只从登记的域名下载，有大小上限，必须是脚本 | 登记的跳转正常下载并给出最终地址和 SHA-256；跳到未登记的域名、HTTP、带账号的地址、超过 1 MiB、错误页面、404 都拒绝且不保存文件，未登记的域名不会被请求 | planned |
| G011-IN2 | G011 | unit | 安装改动的记录方式 | Codex 按 $SHELL 选择启动文件；增删的行逐行记录；产品配置只记录变化的键，已知安装字段显示值，其他键不显示值，无法解析时记为整个文件；被拒写入取错误信息紧挨着的那个路径，不取脚本自己的路径 | planned |
| G011-IN3 | G011 | unit | 每个产品登记一种官网安装方式 | 四个脚本产品的地址在登记的域名里，可写位置都是家目录下的普通相对路径，并包含程序落点；四个 npm 产品；Hermes 只给命令；目录外的产品没有 | planned |
| G011-IN4 | G011 | unit | 官网安装请求与冻结的安装请求 | 官网安装请求只带确认的指纹；冻结的请求逐字段校验（脚本必须有副本、摘要和解释器，npm 必须有前缀、版本和 npm；路径必须是绝对路径，环境变量名受限） | planned |
| G011-IN5 | G011 | integration | 经正式入口用官方脚本安装缺失的产品 | 确认显示最终地址、SHA-256、可写位置、产品配置文件和终端指向；脚本在真实沙箱里运行，写入 ~/.zshrc 被阻止并记录；~/.claude.json 只记录 installMethod 的改动；装好后列表出现脚本安装；已有官网安装时不再安装第二份；同一命令重复提交返回同一任务 | planned |
| G011-IN6 | G011 | integration | 安装脚本的来源与副本受保护 | 跳到未登记域名的脚本不下载并返回 409；确认后被改动的副本不运行，任务为没有安装；未知或过期的确认返回 409 | planned |
| G011-IN7 | G011 | integration | npm 产品按确认的精确版本装入 PATH 上第一个 Node.js 的前缀 | 经本机假 npm 仓库安装，确认显示版本、前缀、Node.js 满足情况和终端指向；装好后列表出现 npm 安装；Node.js 不满足范围时确认显示原因，提交返回 409 且什么都不装 | planned |
| G011-IN8 | G011 | integration | 会改 shell 配置的安装脚本与带参数的安装脚本 | Codex 式脚本只能改 ~/.zprofile，增加的行逐行记录，写入 ~/.codex/config.toml 被阻止且原内容不变；OpenCode 式脚本收到 --no-modify-path，目录不在 PATH 上时确认如实说明 | planned |
| G054-IN1 | G054 | e2e | 按官网方式安装的确认框 | 不能安装时说明原因并禁止确认；否则显示官网命令、版本、实际运行的命令、前缀、Node.js 和产品说明，以及安装后终端里的命令指向哪一份；提交的内容正好是确认的指纹；任务显示为等待安装；无页面错误 | planned |
| G011-UG1 | G011 | unit | 按 Homebrew 预演输出读出升级计划 | 按 Homebrew 7.0.9 的真实输出格式，读出一并升级、新装和依赖者升级的包及前后版本；tap 警告和清单下载行不算包；标为弃用或停用的包单独列出；共享运行时（node、python 等）被单独指出 | planned |
| G011-UG2 | G011 | unit | 逐份升级的请求、冻结的升级请求与任务事实 | 升级请求只带安装引用和确认的指纹，带配方字段被拒；冻结的请求逐字段校验（重跑脚本必须有副本、摘要和解释器；路径必须是绝对路径；环境变量名受限；不接受只给终端命令的方式）；完成的任务必须读到新版本且与任务版本一致，只有升级任务带升级事实 | planned |
| G011-UG3 | G011 | unit | 每种脚本安装登记自己的更新方式 | Claude Code 与 Cursor 用产品自己的更新命令；Codex 与 OpenCode 重新运行官方脚本；Hermes 只给终端命令并写明它会 stash、迁移配置、重启网关；适配器的升级只显示现版本与目标版本，不带任何验证判定（ADR-053） | planned |
| G011-UG4 | G011 | unit | 安装的版本按渠道记录读取，Homebrew 沿用用户的家目录、设置和本地记录 | npm 读包的 package.json，Homebrew 和带版本目录的脚本读命令解析到的版本目录；适配器的脚本布局不当作产品；Homebrew 运行环境用真实 HOME、用户的 HOMEBREW_* 设置和缓存，并强制不自动 update、cleanup、autoremove | planned |
| G011-UG5 | G011 | unit | HarnessHub 自己运行这份安装的进程单独列出 | 本进程后代中命令行指向安装目录、或打开了安装程序文件的进程列为 own，不与其他程序混列；本进程自己不列 | planned |
| G011-UG6 | G011 | integration | 经正式入口把 npm 安装升级到确认的精确版本 | 确认显示现版本、目标版本、实际运行的命令和可写前缀；用前缀的 npm 从本机假仓库装入精确版本，任务记录前后版本；同一确认不能用第二次；已是最新时如实说明；确认后安装有变化时返回 409 且不升级 | planned |
| G011-UG7 | G011 | integration | 会自更新的脚本安装运行产品自己的更新命令 | claude update 在真实沙箱里只能写安装目录和 ~/.claude.json；写入 ~/.zshrc 被阻止并记录；设置只记录变化的键；任务记录前后版本；在最新版本上再运行显示“已是最新” | planned |
| G011-UG8 | G011 | integration | 没有更新命令的脚本安装重新运行官方脚本 | 确认显示脚本来源、SHA-256 和实际运行的命令（带 --no-modify-path）；确认后被改动的副本不运行且什么都不改；正常时装入新版本并记录前后版本 | planned |
| G011-UG9 | G011 | integration | Homebrew 安装按本地记录升级，预演列出一并升级的包 | 检查更新读 Homebrew 本地记录；确认列出一并升级的包、共享运行时、本地记录日期、预演说明和弃用提示；预演改动了已装的包时停止（无效样例）；确认后计划变化时任务不升级；正常时升级并核实新版本 | planned |
| G011-UG10 | G011 | integration | 逐份升级的使用者、服务、结果核实、终端方式与 ADR-043 的分工 | HarnessHub 自己的进程在运行这份安装时，正在回复的对话阻止升级，空闲保留进程先关闭；没有自己的进程时不关闭对话；后台服务在运行时拒绝；结果未知时核实只读版本、不重跑；Hermes 只给终端命令并提示本地改动；声明服务且控制入口在这份安装里的产品由 ADR-043 的升级负责 | planned |
| G054-UG1 | G054 | e2e | 逐份升级的按钮与确认框 | 每份安装显示上次检查的结果；正在回复的对话阻止升级并可打开该对话；否则显示前后版本、实际运行的命令、可写位置、仍在运行的程序和“当前使用”说明（不再有未验证提示，预发布版只作中性事实，ADR-053）；提交的内容正好是确认的安装和指纹；完成摘要写出前后版本；Hermes 只显示终端命令、它会做的事和本地改动，没有确认按钮；无页面错误 | planned |
| G011-UP9 | G011 | integration | 升级安装期间别的程序改写受保护配置 | npm 在配置写保护沙箱里安装期间，测试进程改写 ~/.claude.json；升级照常完成，原配置判为保留，任务日志写明这些文件在升级期间有变化、来自仍在运行的程序 | planned |
| G064-R1 | G064 | unit | 按“谁读什么”表计算技能对每个 Harness 的可见机制与状态 | 共享目录原生读取、逐个链接、自有副本、兼容目录、外部目录各有其机制；Claude 同一 realpath 只算一份，Codex 两份都可见，OpenCode 同名只保留一份且不确定是哪一份，Gemini、OpenClaw、Pi 按优先级遮蔽；OpenClaw 越界链接被跳过；断链、缺 SKILL.md 与不合规 frontmatter 各有状态；停用状态按各 Harness 的配置显示 | planned |
| G064-R2 | G064 | unit | 各 Harness 配置的容错读取与停用状态 | 带注释的 JSONC、TOML 表数组、YAML（含 dsh 的 !!js 标签）都能读；Claude skillOverrides、Codex [[skills.config]]、Gemini skills.disabled、OpenCode permission.skill、Hermes skills.disabled 与 external_dirs、OpenClaw skills.entries 读成停用状态；解析失败的文件标为无法读取，不猜；Hermes 与 OpenCode 找出技能文件夹里嵌套的技能，Hermes 读隐藏目录而其他 Harness 不读，.git 一律跳过 | planned |
| G064-R3 | G064 | unit | MCP 服务只读出不含值的事实 | 各家写法的传输方式、程序名、远程主机、变量名与引用写法都能识别；环境变量与请求头的值、URL 的路径与查询都不进入结果，只计明文值的个数；被停用的服务标为停用 | planned |
| G064-R4 | G064 | unit | 指令、子 Agent、命令、Hooks 与插件的读取与交叉读取 | 按各家规则选出生效的用户级指令文件并标出遮蔽（OpenCode 回退读 CLAUDE.md 等）与其他管理器的标记；Cursor 读 Claude 与 Codex 的子 Agent、运行 Claude 的 Hooks 标为交叉；Hermes 标为不支持用户级指令；插件按各家状态文件列出；子 Agent 与命令按本机版本读取：Claude、Codex 的子 Agent 递归、按 name；OpenCode 的子 Agent 与命令递归、嵌套名用 / 连接、modes 也算 Agent；Gemini 只读顶层普通文件，_ 开头的与链接列出并写明不读；Cursor CLI 不读家目录的子 Agent，读 ~/.cursor/commands 与 ~/.claude/commands 顶层；Codex 0.118 起不读 prompts | planned |
| G064-R5 | G064 | integration | 经正式入口读取统一视图 | 临时家目录里九个 Harness 的官网安装与布局经 GET /api/v1/capabilities 得到正确的条目、机制、状态与提示；响应不含密钥值与家目录绝对路径；无法读取的文件如实列出；只读文件，不运行任何 Harness 程序（OpenClaw 按 ADR-045 第 11 条以 JSON5 只读解析 openclaw.json） | planned |
| G054-CA1 | G054 | e2e | 能力页面 | 侧栏的“能力”打开页面；七个页签各显示条目与每个 Harness 的状态，提示可展开；空状态如实说明；无页面错误 | planned |
| G064-W1 | G064 | unit | 按格式定点编辑各 Harness 的配置，并在写入前校验只改了目标设置 | JSON/JSONC（注释、缩进、BOM、CRLF、单行列表）、Codex TOML（表数组、注释、多行字符串、模型键）、Hermes YAML（注释、flow 与 block 列表、缺键与空值）除目标行外逐字节不变；越界改动的无效样例被校验拦下；显示的差异按键名、令牌形态、参数与 URL 打码，变量引用与普通值保留 | planned |
| G064-W2 | G064 | unit | 各 Harness 的技能开关计划、台账与存储 | Claude skillOverrides、Codex [[skills.config]] 按路径、Gemini/Hermes skills.disabled、OpenCode permission.skill（最后匹配者胜、不删用户的 allow）、OpenClaw config set/unset 各自生成正确的计划；启用时恢复 HarnessHub 替换掉的值；已是目标状态的不改；存储每个文件只留最近 10 份备份、按 commandId 重放修改结果，较新的所有者代际会挡住旧的；台账按写入它的开关的读法从文件读回 HarnessHub 写的值（被移除为没有、被改动为现值，不认识的键与解析失败的文件拒绝而非当作移除）；再次写入时只有替换 HarnessHub 自己的值才保留它首次写入前的原值，否则换成这次写入前的值 | planned |
| G064-W3 | G064 | integration | 经正式入口停用和启用技能、拒绝不安全的写入并恢复备份 | 临时家目录里经 GET /api/v1/capabilities/skill-switch 先显示精确差异、不写入；确认后只改目标设置并留备份，同一命令重放返回首次结果，同一确认换命令号为 409；启用后 Claude 文件逐字节回到原样；确认后文件被改、目标是符号链接、没有开关的 Harness、看不到的技能都在写入前拒绝；Codex、Hermes、OpenCode 保留注释与其他键，差异中家目录写成 ~ 且凭据打码；备份恢复前显示差异并提示此后是否被改过；没有在沙箱外运行任何 Harness 程序；在 umask 077 与 umask 0 下写入后目标文件保持原权限（0644），备份为 0600 | planned |
| G064-W4 | G064 | probe | 用本机真实的 OpenClaw 在私有家目录里切换技能 | 在只可写私有状态目录、禁网的沙箱里：先对副本运行同一条官方命令得到精确差异且不改真实文件；确认后 config set 写入的结果与预演一致；config unset 启用；恢复备份后文件（含注释）回到原样；不接触真实的 ~/.openclaw 与 Gateway | planned |
| G054-CA2 | G054 | e2e | 能力页的技能开关与恢复 | 展开技能后各有开关的 Harness 显示停用或启用（Codex 按每一份）；确认框显示文件、谁写的现有设置与红绿差异，确认前不发送；发送的正是确认的检查；结果可一键恢复修改前的文件，恢复也先显示差异；无需修改的检查不能确认；无页面错误 | planned |
| G064-W5 | G064 | integration | 经正式入口放置共享技能、清理多余链接并撤销 | Hermes 经 skills.external_dirs 读取或停止读取共享目录，差异只在这一项；没有读取共享目录时不提供清理它的链接；清理只删指向共享目录的链接并记录，撤销按原样（相对路径）放回；确认后被改动的链接一个都不动；Claude Code 用绝对路径链接放置看不到的共享技能，只能移除 HarnessHub 放置的链接，已能看到的不重复放置；不适用的 Harness 与不存在的技能被拒绝 | planned |
| G064-W7 | G064 | integration | 经正式入口检查漂移：外部移除或改动 HarnessHub 写过的设置与链接 | Hermes 整份重写 config.yaml 去掉 HarnessHub 加的 external_dirs、用户把 Claude 的 off 改回、HarnessHub 放置的链接被删后，history 的 drift 分别显示已移除、已改动、已移除，读取不改任何文件；重新应用走原来的检查与确认（链接放回、off 重写且之后启用改回用户的值）；文件无法解析记为无法核对；不再跟踪只删台账、文件不变，重复为 forgotten:false，仍是 HarnessHub 写的值时 409；未知编号 404、格式不对 400；回答不含家目录绝对路径与凭据 | planned |
| G064-W6 | G064 | unit | Hermes 共享目录的计划，以及按各家规则找技能 | 共享目录只加一次，按任何解析到它的写法移除，单个字符串的写法不改（按各家规则找技能由 G064-R2 覆盖） | planned |
| G064-W8 | G064 | unit | 技能文件夹的 tree id、仓库压缩包的读取、文件夹命名、lock 的定点修改、快照与指向技能的链接 | 本地算出的 tree id 与真实 git 一致（排序、可执行位、链接、空文件夹，含与不含 npx skills 的排除项），与 GitHub 树接口的列表一致；文件夹名按 npx skills 的规则，空名与 .. 拒绝；只接受 GitHub 仓库，其他主机、HTTP、账号、查询串、点段与多余路径段被拒绝；压缩包列出技能并标出可执行文件，嵌套技能归外层，.git 里的不算，含链接的技能被拒绝，越界、绝对路径、多个顶层目录与非压缩包被拒绝；在 umask 077 下写出的技能仍是 0755/0644，不含 metadata.json；lock 只改目标条目的字段，其余字节不变，未知字段保留，旧版本、新版本与非 lock 格式拒绝写入；快照放回的文件夹 tree id 相同，篡改的快照被拒绝；只在 Harness 自己的技能目录里找链接，不碰 Claude 的 synced 与 .trash | planned |
| G064-W9 | G064 | integration | 经正式入口从 GitHub 添加技能、按来源更新、撤销，以及本地改过的技能 | 读取仓库列出新的、被拒绝（含链接）与同名冲突的技能，读取与检查都不写入；检查显示文件夹、文件数、可执行文件数、来源提交与“只改共享目录”的说明；在 umask 077 下添加后文件夹为 0755/0644、不含 metadata.json，lock 字节不变，视图把它记为 HarnessHub 安装、来自该仓库；上游更新后检查更新显示有新版本，更新检查逐个列出新增、修改、删除的文件，应用后文件夹是新版本；撤销从快照放回旧版本；本地改过时更新被阻止，带 overwrite 后说明覆盖的文件数；只请求 GitHub 自己的主机；回答不含家目录绝对路径与凭据 | planned |
| G064-W10 | G064 | integration | 经正式入口更新与删除 npx skills 装的技能，清除孤立的停用设置，撤销删除 | lock 里记了来源的技能显示有新版本；更新检查按记录的 tree id 取旧版本判断本地未改，lock 的差异只涉及 skillFolderHash 与 updatedAt；应用后文件夹是新版本，lock 只改这两个值、其余字节不变，先备份了 lock；删除检查列出 npx skills 建的链接（其他工具）、要删的 lock 条目和留在原处的停用设置；应用后文件夹、链接与 lock 条目都不在了；历史列出孤立的停用设置，清除走开关检查并删掉它；撤销删除放回文件夹、按原写法重建链接、放回 lock 条目 | planned |
| G064-W11 | G064 | integration | 跳转到 GitHub 以外的主机、匿名额度用完、确认后被改动，以及存储从 v2 降到 v1 | 压缩包链接跳到别的主机时返回 502 并说明不跟随，那台主机从未被请求；仓库内的文件夹缩小列表；检查之后有人放了同名文件夹时应用返回 409、不写入；树接口额度用完时检查更新显示无法检查并说明额度；降级脚本把存储改回 v1：只剩 v1 的表，技能改动的记录删除，其他记录保留 | planned |
| G064-W12 | G064 | unit | OpenCode 2 的 permissions 数组按自己的写法停用与启用技能，V1 文件仍按 permission.skill（ADR-053，2026-11-01） | opencodePermission 跨文件、跨两种写法按加载顺序取最后匹配的规则；停用时在 permissions 末尾追加 {action: skill, resource: <名>, effect: deny}，注释、shell 规则与用户的 skill 规则原样保留，台账键为 permissions.skill/<名>，写法依据作为 note；再停用为 none；启用时删掉 HarnessHub 自己的 deny，文件逐字节回到原样；被其他模式拒绝时末尾追加 allow 并在说明里点名那条 V2 规则；没有 permissions 的文件会建出数组、启用后数组随之去掉、文件逐字节回到原样；单行数组保持单行；用户自己的 ask 规则被替换后按台账恢复并移到末尾，别人的 deny 只删除；同时有 permission.skill 与 permissions 的文件两种写法都拒绝（混用），permissions 不是列表时拒绝；不传写法时仍写 permission.skill；heldValue 读回 permissions.skill/<名> 与 permission.skill/<名>，以及 V2 文件里 mcp.servers 下与 V1 文件里 mcp 下的服务器自有键 | planned |
| G064-W13 | G064 | integration | 经正式 Gateway 在 OpenCode 2 写法的文件里停用与启用技能，不论本机装的是哪条线 | 本机安装是 npm opencode-ai（OpenCode 1），而 opencode.jsonc 已用 permissions 数组：检查不阻止，notes 写明“写法：文件里已有 OpenCode 2 的写法（permissions）”，差异显示追加的 skill 规则；应用后文件保留注释、没有 permission 键、permissions 末尾是 {action: skill, resource: alpha, effect: deny}；能力视图里该技能对 OpenCode 显示停用、原因写明 permissions 的 skill 规则与 resource；启用后文件逐字节回到原样；回答不含凭据与家目录，没有程序在沙箱外运行 | planned |
| G064-M1 | G064 | unit | MCP 服务器的中立定义、各 Harness 的写法与可表达子集，以及 Codex、Hermes、JSON 三种文件的定点编辑 | 六种写法读成同一个定义并按各自的变量引用写回；Codex 只能同名转发、请求头不能带前缀、不支持 SSE，Hermes 不支持 SSE，表达不了时拒绝并说明；名字或值像密钥的字面值、小写变量名、非本机 HTTP、带查询串的地址、shell 字符、含密钥的参数、相对工作目录被拒绝，普通设置可以是字面值；Codex 的表组整组增删、更新只改自有键并保留用户的超时与工具审批，其余字节不变；Hermes 在空映射里增删条目，最后一个删掉后回到 {} 且逐字节回原样；JSON 只改自有键，注释与用户的键保留 | planned |
| G064-M2 | G064 | integration | 经正式入口导入、认领、按各家写法写入、清单改动后更新与移除 MCP 服务器 | 列出各 Harness 已有的服务器，明文密钥与带令牌的地址不能导入；导入并认领一致的那一项不改文件；写入 Codex 只多出它自己的表，其余字节不变，确认框写明会以用户身份运行的程序与所需变量（只说是否已设置）；写入 Gemini、Cursor 用各自的引用，Cursor 提示编辑器共用文件；清单改动后各处显示待更新，更新只改自有键并保留用户加的超时；写入 DeepSeek Harness 时新建它对所有 profile 生效的补丁文件、只含 HarnessHub 自己的 insert，移除后留下 []；profile 里用户自己的服务器可以导入；从 Cursor 移除只删 HarnessHub 写的一项；仍有 HarnessHub 写的条目时不能从清单删除；回答不含家目录绝对路径与凭据；DeepSeek Harness 的补丁文件由 HarnessHub 新建时，移除最后一个服务器后删除文件（说明会删除），原来就有的回到 []，“由 HarnessHub 新建”的记录不进漂移列表 | planned |
| G064-M3 | G064 | integration | 被外部改动的条目、同名的用户条目、表达不了的传输、名字与非法定义，以及存储从 v3 降到 v2 | 用户自己的同名条目即使带 overwrite 也不覆盖；HarnessHub 写的条目被手改后显示被外部改动并进入漂移列表（不算孤立的停用设置），不带 overwrite 时阻止，经重新应用写回；SSE 服务器对 Codex、Hermes 显示不支持并拒绝写入；名字超过 32 个字符的服务器对 DeepSeek Harness 显示不支持并拒绝写入，对其他 Harness 不受影响；明文密钥、非本机 HTTP、shell 字符、参数中间的 ~/ 被拒绝，变量改名的服务器对 Codex 阻止；降级脚本删除清单、MCP 的修改记录与台账，保留备份与其他记录 | planned |
| G064-M4 | G064 | unit | Claude Code 的 MCP 经它自己的命令写入：副本预演、只比对服务器这一项、会话冲掉写入 | 检查在私有副本上运行 claude mcp add-json，真实文件不变，确认框显示命令与 Claude 自己补的键；确认前运行中的会话改了其他键也照常写入，真实运行只可写 Claude 的文件与它的 backups、telemetry 目录；更新先删后加；会话写回旧副本后显示被移除并进入漂移列表，不带 overwrite 时阻止；确认后服务器被改动时拒绝；移除只删 HarnessHub 写的这一项 | planned |
| G064-M5 | G064 | probe | 本机真实的 Claude Code 在私有家目录与禁网沙箱里添加并删除一个服务器 | 副本预演通过且真实文件不变；应用后服务器按 Claude 的写法写入、变量引用保持原样，其他服务器、计数与项目设置不变，留有备份；删除后只剩原有的服务器；不读写真实的 ~/.claude.json | planned |
| G064-M6 | G064 | unit | DeepSeek Harness 的 MCP 客户端行与补丁列表 | 按 dsh 的写法读出服务器（!!js process.env.X 为引用，process.cwd() 等同不写工作目录），写回时变量与带前缀的请求头都是 !!js 表达式，不支持 SSE，读不了的表达式拒绝；空列表 [] 里加入一条后是块列表，第二条在后，原位替换，全部移除后逐字节回到原文件；原来没有的文件新建为列表、移除后留下 []，绝不留空文件；单行的非空列表与非列表的顶层被拒绝 | planned |
| G064-M7 | G064 | unit | OpenCode 2 的 MCP 写法（mcp.servers）与 OpenCode 1 的（mcp.<名>）各自原样读写（ADR-053，2026-11-01） | opencodeMcpStyle 按文件自己的服务器位置选 opencode 或 opencode-v2，两条路径互不看见对方的服务器；同一服务器在两种写法里渲染相同（type local 的 command 数组、type remote 的 url，{env:NAME} 引用），MCP_OWNED 相同；V2 文件加服务器写进 mcp.servers、保留注释与 timeout 默认值、只改自有键而留下用户的 disabled，删除后逐字节回到原样；V1 文件加服务器仍写在 mcp 下、不出现 servers，删除后逐字节回到原样；没有服务器的文件按调用方决定的写法建出 mcp.servers.<名> 或 mcp.<名>，最后一个服务器删除后整个 mcp 键也去掉、文件逐字节回到原样；按 V1 路径读 V2 文件会把 servers 容器当成服务器，所以写法在任何改动前先按文件判定 | planned |
| G064-M8 | G064 | integration | 经正式 Gateway 把清单里的服务器写进 OpenCode 2 写法的文件，不论本机装的是哪条线 | 本机安装是 npm opencode-ai（OpenCode 1），而 opencode.jsonc 已用 mcp.servers：候选里列出该文件自己的服务器、不把 servers 或 timeout 当服务器；写入检查不阻止，notes 写明“写法：文件里已有 OpenCode 2 的写法（mcp.servers.<名>）”，差异不含 TWO_TOKEN；应用后 mcp.servers 多出该服务器（type local、command 数组、environment 的 {env:FS_TOKEN}）、timeout 默认值与其他服务器不动，状态为 synced；移除后文件逐字节回到原样；回答不含凭据与家目录，没有程序在沙箱外运行 | planned |
| G064-I1 | G064 | unit | HarnessHub 指令区块的解析、写入与移除 | 区块追加在文件末尾、与原内容空一行，记下加入的分隔；原地替换时区块前后的字节不变；移除后逐字节回到写入前（含 BOM、BOM 加 CRLF、混合换行、末尾无换行的情形，区块后有用户内容时保留分隔）；区块里的内容被改过时与开始标记的 sha 不符；无法识别的标记（id 不是 instructions、sha 大写、有前导空白）、重复或缺失的标记都被拒绝；文本超过 16 KiB（按 UTF-8 计）、含 NUL 或换行与制表符以外的控制字符、含孤立的代理项、含区块标记或写出家目录的完整路径时拒绝 | planned |
| G064-I2 | G064 | integration | 经正式 Gateway 保存指令，按各 Harness 的规则选文件写入、更新、移除与恢复；OpenCode 回退、Claude 文件、OpenClaw 工作区与 cc-switch 的确认 | 保存只改 HarnessHub 的存储，含家目录、控制字符、标记、孤立代理项或未安装 Harness 的文本被拒绝；每个 Harness 显示它读的文件或不写的原因；Codex 跳过空白的 override，Gemini 取 context.fileName 里第一个存在的名字；每次检查第一句声明只改区块、不改模型与登录配置；DeepSeek Harness 的区块接在原内容后、空一行，权限不变、有备份、命令重放不重写；Codex 写进非空的 AGENTS.override.md 并接上它的追加文本，不提 32 KiB；检查后文件被改时返回 409；更新原地替换并保留区块后的用户内容，移除后逐字节回到原样；HarnessHub 新建的文件为 0600，移除后删除，备份记下已删除，恢复时说明没有被改过并以 0600 重建；目标是符号链接时拒绝；OpenCode 回退读的 CLAUDE.md 有用户内容时要 create-own 并给出改写 Claude 文件的替代做法，两个文件都不存在时直接新建并说明不再回退，移除后删除文件并说明恢复回退；Claude 的检查说明 OpenCode 也会经回退读到、删除后它也读不到，之后 OpenCode 显示经 Claude 文件生效，再新建它自己的文件不用确认；OpenClaw 超过 bootstrapMaxChars 时阻止，列出配置的频道（不含频道里的值）与多个 agent 时只写默认 agent，提示 git，工作区文件不存在时阻止、不替它新建；有 ~/.cc-switch（目录不可读）时它写的 0 字节文件先提示与 cc-switch 停用状态一致，第一次写入要 acknowledge-cc-switch，更新 HarnessHub 自己的区块不再阻止，移除回到 0 字节；降级脚本删除指令文本、历史与台账，其他记录保留；回答里没有家目录路径与密钥 | planned |
| G064-I3 | G064 | integration | 外部改动后的状态与漂移、认领、Codex 出现 override 后的遮蔽与陈旧记录、未安装的 Harness、存储版本 | 未安装的 Pi 不出现；区块里被改过时显示被改动并进入漂移列表，覆盖与移除都要 overwrite，孤立设置列表为空；HarnessHub 更早写的版本被写回时如实说明；手工删掉的区块显示被移除，重新应用后回来；无法使用的标记在漂移里显示无法读取、阻止写入，可以不再跟踪；内容一致而无记录的区块可以认领且文件不变，不一致时拒绝；Codex 出现 override 后原区块显示被遮蔽，要先从原文件移除；原文件已没有区块的旧记录随新文件的写入删除；不留临时文件；读取器拒绝比它新的存储版本，降级后的 v3 数据库能重新打开并回到 v4，指令文本为空、备份数不变 | planned |
| G064-A1 | G064 | unit | 子 Agent 的四家格式、名字与文本规则、同名查找 | Claude、Gemini 只写 name 与 description 的 frontmatter，OpenCode 写 description 与 mode: subagent，Codex 只写 name、description、developer_instructions（多行基本字符串，转义引号与反斜杠）；引号、反斜杠、#、像 frontmatter 的行在四种格式里都原样读回；两段文本按存储方式去掉首尾空白；读取表列出的四家内置名全部被拒绝并写明是哪家的；名字不合规、说明多行或超过 1024、正文为空、超过 32 KiB、以 --- 行开头、含控制字符、孤立代理项或家目录完整路径时拒绝；Gemini 的正文含 ${ 时不支持；同名查找按各家规则：Codex 与 Claude 递归看 name，Gemini 只看顶层普通文件、跳过 _ 开头的与链接，OpenCode 看路径（frontmatter 的 name 优先） | planned |
| G064-A2 | G064 | integration | 经正式 Gateway 把清单里的子 Agent 写入四家、更新并移除，必要时新建并删除目录 | Claude、Codex、Gemini、OpenCode 可写，Cursor（本机 CLI 只读工作区）、Pi、Hermes、OpenClaw、DeepSeek Harness 说明为什么不写；内置名、不合规的名字、以 --- 开头的正文、家目录路径、多行说明被拒绝，文本按去掉首尾空白保存；检查第一句声明只新建 HarnessHub 自己的文件、不写工具与权限，并写明继承什么；文件 0600、内容与各家格式一致；OpenCode 没有 agents 目录时新建为 0700 并记为 HarnessHub 新建，移除最后一个文件后删除，原有目录保留；命令重放返回第一次的结果；检查后文件被改返回 409，改过的需要覆盖；清单在 HarnessHub 的文件还在时不能删除；没有漂移 | planned |
| G064-A3 | G064 | integration | 同名定义、认领、外部改动与移除后的子 Agent 状态 | Claude 的 team/lead.md、OpenCode 的 modes/focus.md、Codex config.toml 的 [agents.<名>] 都算同名定义，不覆盖；Gemini 不读的 _ 开头文件不算冲突，目标位置是链接时不经它写入；Gemini 正文含 ${ 时只在 Gemini 不支持；config.toml 无法解析时不写 Codex；内容一致的文件可以认领、文件不变；被改动的进入漂移列表、要覆盖才写回，被删除的经重新应用写回；HarnessHub 的文件旁出现同名定义时状态保持并说明，仍可移除；孤立设置列表为空；配置目录不存在时不替它新建 | planned |
| G064-A4 | G064 | integration | 由文本新建、编辑、撤销与删除共享技能 | 不合规的名字、含 !`…` 或 ```! 的正文、家目录路径被拒绝；与现有文件夹不分大小写同名时阻止，与 Claude、OpenCode 内置命令同名时警告；检查显示 SKILL.md 的差异与各家参数的差别、提示放到 Claude Code；写入文件夹 0755、SKILL.md 0644，不写 lock，视图里归 HarnessHub、来源为“HarnessHub 新建”；检查更新时说明没有上游；编辑读回文本、无变化时不写、文件夹被改过时要覆盖并列出改动数，改写后可以撤销；删除走现有删除流程；新建后撤销不留文件夹与记录 | planned |
| G054-CA3 | G054 | e2e | 共享技能目录卡片、Hermes 读取、清理链接、撤销与 Claude 放置 | 卡片写明各 Harness 怎样读取共享目录与多余链接数；让 Hermes 读取时显示差异与提示；清理逐个列出链接，历史里可撤销；Claude Code 可以放置看不到的共享技能、移除 HarnessHub 放置的；每次确认只发送自己的检查；无页面错误 | planned |
| G054-CA4 | G054 | e2e | 漂移提示、重新应用与不再跟踪 | 页面列出 HarnessHub 写过、已不在原处的设置（Harness、类别、名称、状态与文件），说明不会自动改回；重新应用先显示原来的检查与差异，确认才发送且只发送这次检查；不再跟踪只发送这一项，清空后提示消失；无页面错误 | planned |
| G054-CA5 | G054 | e2e | 添加、检查更新、更新、删除技能与清除孤立的停用设置 | 先读取仓库再选择，被拒绝的技能不能选，读取不发送修改；确认框显示新增的文件夹、文件数与可执行文件数、来源与说明；检查更新后技能标出有新版本，更新的确认框逐个列出文件改动和 lock 的差异；删除的确认框按归属分组列出链接，并列出留在原处的停用设置；孤立的停用设置可以清除，确认后提示消失；历史为技能改动提供撤销；只发送确认过的检查；无页面错误 | planned |
| G054-CA6 | G054 | e2e | MCP 统一清单的矩阵、写入、认领、导入与新建 | 每个服务器按 Harness 显示已写入、一致、未写入、不可写，并标出所需变量是否已设置；写入先显示差异与将运行的程序，确认才发送且只发送这次检查；认领与导入不改文件，含明文密钥的不能导入；新建的服务器只保存变量名；Claude 里被会话冲掉的服务器在漂移列表里显示为写入丢失；无页面错误 | planned |
| G054-CA7 | G054 | e2e | 统一指令卡片的编辑、保存与写入 | 每个 Harness 显示文件、状态、何时生效与写入前要确认的事；编辑后提示未保存并停用写入，保存只发送文本；写入的确认框被 cc-switch 阻止时，用户点“我知道，仍然写入”才重新检查并显示区块差异，只确认这次检查；Cursor 提供复制共享指令；无页面错误 | planned |
| G054-CA8 | G054 | e2e | 统一子 Agent 卡片与新建技能对话框 | 每个子 Agent 按可写的 Harness 显示状态，不写的 Harness 在表格下说明原因；写入先显示新文件与继承说明，只确认这次检查；新建子 Agent 只发送名字、说明与正文；新建技能的对话框收集文本后走自己的检查，显示 SKILL.md 差异与参数说明；无页面错误 | planned |
| G064-P1 | G064 | unit | Codex 插件表的定位与启停只改一行 | 表头按 TOML 规则解析（裸键、含转义的双引号键、单引号键、点号两侧空白、行尾注释），多行字符串里的表头和非表头行不算；按段定位 [plugins."<id>"]，紧随的子表不算；enabled 原地改值、保留行尾注释，缺键时插在表内最后一个键之后（CRLF 文件插在 \r 之前，技能开关的表数组同样适用），差异恰好一行且 smol-toml 仍能解析；写在 [plugins] 下的点号键、内联表、没有这个插件、enabled 不是布尔值、同名表出现两次时拒绝；原值为显式 true 时启用写回并删除台账，缺键时启用写明 enabled = true 并记台账；他人写的 false 标明来源 | planned |
| G064-P2 | G064 | unit | Claude Code 插件开关的定点编辑与台账规则 | 只改 enabledPlugins.<id>：停用原地改成 false，或新增 false 并注明原来按默认启用；已是目标状态时无需修改；启用 HarnessHub 停用的插件时写回原值（原来没有条目且默认启用时删掉这一项，文件逐字节回到原样），原来没有条目而默认停用时写 true 并记台账；他人写的 false 改成 true 并注明；条目不是布尔值时拒绝；改动其他键的无效样例被校验拦下；台账读取认识 plugin/ 前缀 | planned |
| G064-P3 | G064 | unit | Claude Code 插件模型：条目、默认、依赖、账户同步与管理设置 | 用户级安装逐个列出，只装在项目里的计数；defaultEnabled 市场条目优先于 plugin.json，缺省 true；依赖取 plugin.json 与市场条目的并集，三种写法，版本约束不求值，无法识别时报问题；没有 plugin.json 时市场条目就是清单；没有条目、被启用插件依赖的插件算启用；安装目录不存在或市场清单读不到时依赖记为无法核对；账户同步插件按名字跨账户去重、按代际目录读清单、裸依赖按它的市场解析，读不到的清单不带账户 ID；syncClaudeAiPlugins: false 时全部停用；管理设置先读主文件、再按名字序读 .d 的 .json（点文件除外），后者覆盖前者；MDM 描述文件存在、文件或目录读不到、值不是布尔值时为无法确定 | planned |
| G064-P4 | G064 | integration | 经正式入口启停 Claude Code 与 Codex 的插件 | Claude 停用只改一行，确认框写明生效时机与各级覆盖，再启用后 settings.json 逐字节回到原样、没有漂移；停用被启用插件依赖的插件、启用依赖已停用的插件都被拒绝并点名，提示 claude plugin enable 会连带启用；保留来源、账户同步、未安装的插件被拒绝，只读的 Harness 返回 CAPABILITY_UNSUPPORTED，非法 id 返回 400；管理设置文件与 .d 决定插件、MDM 描述文件存在时都拒绝；检查之后文件变了，确认返回 CAPABILITY_TARGET_CHANGED；被外部改回的进入漂移，可重新应用、可不再跟踪；插件卸载后 HarnessHub 写的 false 列为孤立设置，清除后写回原值；Codex 原地改一行、保留注释与子表，启用后逐字节回到原样，缺键的表插入一行、启用写明 true，外部改动进入漂移；回答里没有凭据与家目录 | planned |
| G064-R6 | G064 | unit | 各家插件按自己的规则读取 | Claude 与 Codex 都有的 名@市场 插件合成一行，各自显示版本与位置；没有条目的按默认显示，并计入依赖；有条目但未安装的、inline 等来源不提供开关；账户同步插件按名字去重，位置只到 ~/.claude/plugins/synced，视图不含账户 ID；随 Codex 安装的标明归属，缺 enabled 的写明缺省值未核实；OpenCode 读 plugin/ 与 plugins/ 的 .ts、.js（含点文件、跟随链接）与 tuple 条目并去重，tui.json 的标为 TUI 插件；Hermes 的 disabled 优先、分类布局与 plugin.yml、记忆提供方由 provider 选择、模型提供方不受 enabled 约束、隐藏目录也算、缺 plugins.enabled 时都不启用；DeepSeek Harness 读各 profile 的依赖；每家写明有没有开关及只读的原因 | planned |
| G064-R7 | G064 | unit | OpenCode 的两种配置写法都读取，每个文件说明用的是哪种，安装的产品线决定指令回退与新条目的写法（ADR-053，2026-11-01） | 读表 checkedOn 为 2.2.5；opencodeMcpServers 把 mcp.servers.<名>（V2）与 mcp.<名>（V1）分开读、不把 servers 容器或 timeout 默认值当服务器、名为 servers 的 V1 服务器仍是一个服务器；opencodeFileDialect 按 mcp/plugins/permissions 三族判出 v1、v2、mixed 或 null；opencodeWriteDialect 依次按文件该族已有的写法、安装的产品线、文件其他键、cli.json/tui.json 存在、默认 OpenCode 2 决定，混用时返回 mixed，basis 写明依据，不读版本号；resolveOpenCodeLine 按渠道记录判 @opencode/cli、Core 的 opencode、opencode-v2 为 v2，opencode-ai、anomalyco/tap 的 opencode 为 v1，脚本安装看 opencode2 垫片，没有记录或其他 tap 为 null；读表只在 v1 线给 ~/.claude/CLAUDE.md 的 compat 候选，v2 与未知都只读自己的 AGENTS.md 并在 notes 说明；同一家目录里 V1 文件（enabled: false、plugin 的 tuple）与 V2 文件（disabled: true、plugins 的 {package}、permissions 数组的 skill 规则、cli.json 的 plugins）都读到，MCP 的 enabled 事实分别正确，beta 的停用原因写明 permissions 的 skill 规则与 resource，~/.claude/CLAUDE.md 没有 opencode 的边，notes 写明本机装的是 OpenCode 2 与每个文件的写法 | planned |
| G054-CA9 | G054 | e2e | 插件页的开关说明与合成行的启停 | 插件页写明哪些 Harness 可以启停、其余只读的原因；Claude 与 Codex 都有的插件只占一行，展开后各自显示版本、状态与开关；确认框显示文件、一行差异、生效时机与覆盖提示，确认前不发送、只发送这次检查；被依赖拦下的检查不能确认；历史里有插件开关；无页面错误 | planned |
| G065-A01 | G065 | review | 六项加固的验收记录与 ADR-046 验证节逐项对账：版本来源（2026-10-22 起被 ADR-053 取代，只核对分层一致）、审计记录、流式合并、边界检查、控制层、冻结 | 每项都有对应层的测试或检查通过的记录；真实引擎通过与测试通过分别表述；非焦点三个（Cursor、Gemini CLI、Pi）的矩阵 ✅ 数未增长（complete_at_freeze；已验证版本表已随 ADR-053 删除，不再对账）；全程未写用户真实配置 | planned |
| G060-NC14 | G060 | unit | 真实验收守护：对受守护的共享配置文件做快照并在套件前后比对 | 改动任一受守护文件（内容、权限或存在性）即判为已改动并点名文件，未改动时通过；凭据文件（~/.codex/auth.json、~/.hermes/.env、~/.hermes/auth.json、~/.dsh/.credentials.yaml 等）只核对存在与元数据，不读内容；快照不含文件内容 | planned |
| G060-NC15 | G060 | unit | 真实验收记录的证据头 | 证据头含 commit、安装策略（official 或 any）、每个参与 Harness 的渠道、版本与角色；不含任何路径、家目录或凭据；缺项或含路径的证据头被拒绝 | planned |
| G060-NC16 | G060 | review | 真实套件集合的逐套件审阅：每个 tests/real 套件在前后断言守护未变并写证据头 | 每个真实套件都在开始时快照、结束时断言守护未变，并写出 NC15 格式的证据头；缺一项的套件在操作手册中标为不合格；文档列出套件集合、运行方式与记录格式 | planned |
| G054-FZ1 | G054 | e2e | 冻结的三个 Harness（Cursor、Gemini CLI、Pi）默认隐藏（ADR-048 决定 1） | 默认不出现在选择器、欢迎页、“我的 Agent”与能力页的列里；设置开关“显示冻结的 Harness”打开后出现；停在冻结 Harness 上的对话照常打开并显示其名称；无页面错误 | planned |
| G054-FZ2 | G054 | e2e | 没有后台轮询（ADR-048 决定 8） | 空闲 12 秒内页面不请求 /state；窗口重新获焦且距上次检测 ≥60 秒时触发一次重新检测，不足 60 秒不触发；安装任务进行期间以 800 ms 轮询 /state，任务完成后重新检测一次；手动按钮重新检测 | planned |
| G054-FZ3 | G054 | e2e | 在原程序中继续：只有一次性命令的产品（DeepSeek Harness，任意版本） | 任意版本的 DeepSeek Harness 详情栏都显示只问一次的命令、凭据前提说明与两条提示，不显示交互命令；只有没有续接命令的产品只显示 ID | planned |
| G050-NC9 | G050 | integration | GET /state 与 GET /harnesses 不启动发现 | 两者返回上次扫描结果并带 harnessesScannedAt，不触发发现；只有 POST rescan 才扫描并更新 harnessesScannedAt；HarnessView 带 tier（focus、frozen 或 catalog） | planned |
| G050-NC10 | G050 | integration | publicFailure 的顺序：先把家目录写成 ~ 再截断 | 含家目录绝对路径且超过 512 字的失败消息先把家目录替换为 ~ 再截到 512 字，结果不含家目录；不足 512 字的消息只替换不截断 | planned |
| G011-NC3 | G011 | unit | harnessTier：目录的三层分层 | 七个焦点 id（claude、codex、opencode、dsh、hermes、openclaw、workbuddy）返回 focus，三个冻结 id（cursor、gemini、pi）返回 frozen，目录中的其余条目返回 catalog | planned |
| G008-NC9 | G008 | integration | 业务库 v1→v12 迁移前的备份（ADR-048 决定 6） | 迁移前在 <root>/backups 用 VACUUM INTO 留一份备份；备份的 user_version 与各表行数等于迁移前；迁移后业务库为 v12 且数据不变 | planned |
| G008-NC10 | G008 | integration | 备份只保留最新 2 份 | 连续三次需要备份的版本提升后 backups 目录只剩最新 2 份，被删的是最旧的；目录里不相干的文件不动 | planned |
| G008-NC11 | G008 | integration | 备份失败则不迁移 | VACUUM INTO 失败（备份目录不可写或写入故障注入）时 user_version 不变、不接管 owner，打开以 STORAGE_BACKUP_FAILED 失败且原库字节不变 | planned |
| G032-NC25 | G032 | protocol | OpenClaw 目录探测不写 Gateway，模型覆盖延迟到首回合 | 带模型的目录探测不调用 sessions.patch；模型与默认相同时整个会话不 patch；不同时在第一个 session/prompt 之前 patch 一次并核对 resolved，不一致以 MODEL_MISMATCH 让回合在发提示前失败 | planned |
| G032-NC26 | G032 | protocol | OpenClaw 桥的模式选项与思考档位去重 | 桥的模式选项与思考档位取值相同时，目录与配置读回都不再出现模式选项；取值不同时保留两者 | planned |
| G032-NC27 | G032 | protocol | OpenClaw 转录断档诊断 | 转录只读到最后 200 条且最早一条的 seq 大于回合起点 +1 时发出诊断并如实标明可能缺失；未断档时没有诊断 | planned |
| G034-NC12 | G034 | protocol | Codex 协作模式按能力判断，不按版本号（ADR-034 修订、ADR-053 决定 5） | 模型目录对任何 userAgent 版本（含读不出版本的夹具）都提供 collaboration_mode 选项；只有明确选择了协作模式的连接声明 experimentalApi；夹具不实现 collaborationMode/list（-32601 或明确错误）时，open 带 mode=plan 以 NATIVE_OPTION_UNAVAILABLE 失败，消息含“这个 Codex 不提供协作模式”与原程序给出的原因，open 像任何打开失败一样结束并关闭连接、改变的只是错误码（不再是笼统的 REMOTE_ERROR）、不静默降级；旧 userAgent（plan-old）与无法识别版本的夹具在实现了该方法时计划模式可用；thread/start 与 thread/resume 回包带 collaborationMode、approvalPolicy、sandbox 时经 nativeConfig 回报，字段缺失时不写死缺省；thread/readState/changed 归为被动通知 | planned |
| G032-NC28 | G032 | protocol | $/cancel_request 关闭原程序撤回的审批或提问（claude-agent-acp 0.94.0） | 收到 $/cancel_request {requestId} 时关闭 id 等于 String(requestId) 的审批与 id 为 `${requestId}:<n>` 的提问，发出 decision 为 cancelled 的 permission 事件与“原程序撤回了这项请求”的诊断，不再记为未支持通知；没有匹配的请求时只记诊断，不影响回合；其他 ACP Harness 的同名通知走同一通用路径 | planned |
| G032-NC29 | G032 | protocol | Claude 会话参数关闭 promptSuggestions，/remote-control 隐藏并在用到时明确失败；fork 的超时与分类（ADR-053 裁决 5、6） | ClaudeControl 在 session/new、load、resume、fork 的参数带 _meta.claudeCode.options.promptSuggestions=false（夹具记录参数并断言），其他 ACP Harness 的会话参数不带 _meta；模型目录的命令不含 remote-control；用户发送 /remote-control 时不发给原程序，结果 failed、error.code 为 NATIVE_COMMAND_UNAVAILABLE，消息说明回合结束会关闭适配器进程、Remote Control 随之断开；session/fork 的超时与 open() 一致，fork 的 REMOTE_ERROR 只在 remoteCode 为 -32601 时判 NATIVE_FORK_UNAVAILABLE，其他 REMOTE_ERROR 作为原生失败抛出（副本存在与否未知） | planned |
| G032-NC30 | G032 | protocol | Hermes 审批选项的说明按 option id，错误原因按 JSON-RPC data.details 分类；0.12 的缺陷提示不再出现（ADR-031 修订、ADR-053 例外登记） | 夹具给出 allow_always、allow_session、deny_always 等五个选项时三条说明各出现一次：allow_always 写入所有会话共用的允许列表（含消息网关）、allow_session 只在本会话内有效不写配置、deny_always 等同拒绝不保存；按 id 识别，不按位置，没有这些 id 时退回按 kind 的说明；session/load 或 session/resume 的 REMOTE_ERROR 且 remoteDetail 以 not_found 开头 → NATIVE_SESSION_NOT_FOUND；remoteDetail 匹配 Gateway starting/incompatible/inaccessible/draining/could not start → NATIVE_GATEWAY_UNAVAILABLE 并附 Hermes 给出的原因（截断）；unknown_execution 不映射为失败，只在诊断里透出原因与 /discard 提示；一次回合没有审批请求却出现拒绝文本时不再显示 0.12 的缺陷提示，拒绝文本仍标为失败；initialize 报告 0.12.x 时审批期限仍为 60 秒减 2 秒（登记的例外），其他版本不给原程序期限 | planned |
| G032-NC34 | G032 | protocol | OpenCode 2：已宣告的 compact 不重复补入并原样转发；没有 models --verbose 时只试一次、安静地退回代理级声明（ADR-053，2026-11-01） | initialize 报告 2.2.5 且目录宣告 compact 时，命令目录只有 OpenCode 自己的那条 compact（不补入第二条）；/compact 原样作为 text 块发送，以 compaction_update 回报的回合为 completed；原 CLI 对 models --verbose 以非零退出拒绝时，模型行没有 inputs 细化、两次读目录结果相同、图片附件按代理声明放行，整个控制只尝试一次（夹具记录到的调用恰为一行 models --verbose）；只打印 provider/id 行的 models 输出同样不细化；不读任何版本号 | planned |
| G031-NC2 | G031 | protocol | JSON-RPC 错误的 data.details 有界透出到 ControlError.remoteDetail | error.data.details 为字符串时截到 2 KiB、剔除控制字符后挂到 ControlError.remoteDetail，remoteCode 暴露 JSON-RPC 错误码；details 不进入 message 原文与日志；分类时能看到 details；details 缺失、非字符串或超长（无效样例）都不抛出，remoteDetail 为空或截断；进入用户可见消息的只有匹配固定前缀的分类结果，不回显任意文本 | planned |
| G032-OC1 | G032 | protocol | OpenClaw 键控名册下的默认代理解析（夹具 tests/fixtures/openclaw-bridge-peer.mjs：最小 stdio ACP 代理，Gateway 方法全部走注入的假实现，不运行 openclaw） | 注入的 gateway call 对 agents.list 返回 {defaultId:'ops', agents:[{id:'ops', model:{primary:'deepseek/x'}, workspace:'~/ws'}]} 时会话键为 agent:ops:harnesshub:*、默认模型 deepseek/x、工作区按 agents[].workspace；agents.list 抛错（方法不存在、Gateway 不可达）时静默退回读 openclaw.json：agents.entries 键控名册（default 归属）与旧 agents.list 数组两种形状都正确；selectionRequired 为 true 且没有 defaultId 时 open 以 NATIVE_CONFIGURATION_INVALID 明确失败，不猜 main（无效样例）；open 阶段不写 Gateway | planned |
| G032-OC2 | G032 | protocol | OpenClaw 实时工具流与转录对账按 tool id 去重（latest 的桥实时转发工具事件） | 桥在回合中实时发出 tool_call/tool_call_update（id X）且转录对账也含 id X 时只有一行工具事件、标题以实时事件为准；转录里多出的 id Y 仍补发；实时流没有给出终态而转录里有 isError 时补一条同 id 的 status 更新；用量与真实停止原因仍从转录补；旧桥（不发实时工具事件）的行为不变；去掉去重即重复（变异核对） | planned |
| G032-OC3 | G032 | protocol | OpenClaw 设置回读按桥公布的取值 | sessions.list 行里 responseUsage 缺省时回报桥在 configOptions 里公布的 currentValue 而不是写死 off；fastMode 取 effectiveFastMode ?? fastMode，布尔映射 on/off、字符串 auto 原样；traceLevel 存在时回报 trace_level；只回报目录里存在的选项 id；旧桥的取值不变 | planned |
| G032-OC4 | G032 | protocol | OpenClaw 模型可用性与 fork 按桥的声明判断，不按版本 | models.list 行带 available:false 的模型不可选并带 unavailableReason 说明（没有可选字段时不列出并在诊断里说明数量与原因），open 选它时 MODEL_UNAVAILABLE；fork 不再被驱动硬拒绝：桥不声明 sessionCapabilities.fork 时由通用层报 NATIVE_FORK_UNAVAILABLE 并说明原因，声明时走通用 fork；不读任何版本号 | planned |
| G012-OC5 | G012 | unit | Hermes 最新布局的发现：install-stamp 版本来源、.hermes/bin 程序与新启动器（ADR-051 第 6 条，ADR-053） | 脚本渠道的 Hermes 程序为 .hermes/bin/hermes（0.12 布局的 venv/bin/hermes 作兼容候选）；版本来自 <root>/install-stamp.json 的 displayVersion（缺则 baseVersion），没有 stamp 时才读 venv 的 dist-info，dist-info 为 0.0.0 时版本为 null（无效样例）；版本未知时安装照样算官网安装；launchers 与卸载白名单含 ~/.local/bin/hermes、hermes-acp、hermes-agent；常驻网关正则匹配 'python -m hermes_cli.main --profile default gateway run' 与 '.hermes/bin/hermes … gateway run --external-supervisor' 两种形态，正反样例各有 | planned |
| G012-OC6 | G012 | unit | 渠道登记按最新版：OpenClaw 的官网 npm 命令与 Hermes 的升级说明 | OpenClaw 显示的官网安装命令为 npm install -g openclaw@latest --allow-scripts=openclaw，notes 说明 npm 11.16+ 对生命周期脚本的行为；Hermes 的 upgrade.explains 写明 v0.22.x 的行为（暂停网关、以新代码重启、config/state 迁移且 state.db 写过后不能回退、先 hermes backup、QQ 离线一段时间）；渠道来源链接指向最新版的标签提交；没有任何按版本号的条件 | planned |
| G012-OC7 | G012 | unit | OpenCode 的渠道覆盖两条产品线，产品线只由渠道记录判定（ADR-053，2026-11-01 用户决定换到 OpenCode 2） | productChannels(opencode) 登记 npm @opencode/cli（V2）与 opencode-ai（V1）、Homebrew formula opencode（Core 是 V2、anomalyco/tap 是 V1）与 opencode-v2、脚本 ~/.opencode/bin，来源为 https://opencode.ai/v2/docs/、核对日期 2026-11-01；Cellar/opencode-v2/<v>/bin/opencode 判为 brew-formula、name opencode-v2，receipt 里的 anomalyco/tap 被记下，homebrewName 给出 anomalyco/tap/opencode-v2，版本取 keg 目录名；lib/node_modules/@opencode/cli 下的 opencode 与 opencode2 都判为同一份 npm 安装；~/.opencode/bin/opencode2 在脚本根内；opencodeProductLine 对 @opencode/cli、opencode-v2、无 tap 的 opencode 返回 v2，对 opencode-ai、anomalyco/tap 的 opencode（不分大小写）返回 v1，对脚本、其他 tap、cask、其他包返回 null，不读任何版本号；officialInstallMethod(opencode) 是 https://opencode.ai/v2/install 的脚本、带 --no-modify-path、hosts 含 opencode.ai、notes 写明 opencode2 垫片、不能并存与迁移指南链接；脚本渠道的 removal.files 含 opencode 与 opencode2；页面显示的官网命令为 curl -fsSL https://opencode.ai/v2/install \| bash、核对日期 2026-11-01、附注说明 OpenCode 1 与 2 不能并存 | planned |
| G011-NC4 | G011 | unit | 目录条目的版本跟随渠道（ADR-053 决定 6） | hermes 与 dsh 的目录 package.version 为 'latest'（目录解析器接受非空字符串），注释写明真实验收版本只作证据；dsh 的来源链接指向 dsh-v0.2.1-rc.2 标签提交 687f282e…，hermes 的链接指向 v0.22.4 的 4d04303…；分层（G011-NC3）与既有断言不受影响；目录里没有任何条目把版本当作接入条件 | planned |
| G011-UG11 | G011 | integration | Homebrew 安装用 <tap>/<formula> 全名检查更新、预演与升级 | keg 的 INSTALL_RECEIPT.json 有 source.tap 且不是 homebrew/core 时，安装记录带 tap，brew info 与 brew upgrade --dry-run/升级都用 anomalyco/tap/opencode 这样的全名（假 brew 记录参数并断言）；receipt 缺失、坏 JSON、超过 64 KiB 或 tap 为 homebrew/core 时沿用裸名（无效样例）；裸名可能解析到 Core 同名公式的情况因此不再发生 | planned |
| G011-N04 | G011 | integration | YYYY.M.P-N 修订号的版本比较 | 2026.3.23-2 > 2026.3.23、2026.9.5 > 2026.3.23-2、2026.3.23-2 < 2026.3.23-3；带修订号的本机版本与渠道最新版比较时“已是最新”“可升级到 vX”的判断正确；普通 semver 的比较不变（无效样例：把修订号当预发布会把 2026.3.23-2 排在 2026.3.23 之前，测试拒绝） | planned |
| G011-N05 | G011 | integration | OpenClaw 的 npm 包不单独直装（ADR-052 实现裁决取代了 2026-10-22 的过渡措施） | ADR-044 的逐份升级路径对 OpenClaw 的 npm 安装仍在准备阶段以 409 UNSUPPORTED_UPGRADE 返回，说明要按官方顺序（停 Gateway、逐版本安装并运行 openclaw doctor --fix、再启动 Gateway）在“升级 Harness”里升级、跳过 Doctor 会让新版 Gateway 拒绝启动、路线见 ADR-052，不查找任何发布、不留下预备的检查；维护路径（升级 Harness）对 OpenClaw 不再拒绝，改为运行该顺序（G011-UP10–UP16）；其他产品的 npm 升级不受影响；没有任何按版本号的判断 | planned |
| G032-NC31 | G032 | unit | Hermes 网关预检 A–E 的只读判定（ADR-051 A2）：每个判定有正反样例 | A 只在 gateway_state.json 为 running、记录的 pid 经 ps 核实存活、启动时间与记录一致（容差 5 秒）、命令行是网关（gateway run/restart、gateway/run.py、-m gateway.run；osascript 包装与 gateway status 不算）、记录的 hermes_home 不是别的 profile、gateway.sock 存在且 code_sha 等于 install-stamp.json 的 commit 时成立；pid 不存在、启动时间不符（pid 被复用）、命令行不是网关、别的 profile、状态非 running 都不是 A；code_sha 与 commit 不同或任一侧未知 → B 并给出 hermes gateway status/restart；starting/draining/degraded/conflict 且进程在、更新标记存在、运行但无套接字、锁或 pid 记录占有而无状态、launchd 任务 running 而网关未发布 → C 并说明最多等 60 秒；没有网关而 launchd 服务已加载或 plist 已登记或无法查询 → D（kickstart/bootstrap）；都没有 → E（无监督、空闲即退出的守护进程）；检出没有 acp_adapter/gateway_server.py → in-process，不判定网关；解释文本不含路径，B–E 都写明 HarnessHub 不启动、不停止、不替换且存在竞态；launchctl print 只读顶层 state/pid，ps 行按 lstart 与命令解析；launchd 标签按 service_suffix 规则（默认 home 裸名、profiles/<名> 加后缀、其他 root 加路径哈希） | planned |
| G032-NC32 | G032 | unit | Hermes 网关预检的事实读取只读指定文件、从不读凭据，home 与检出按 hermes 的规则解析 | 临时 HOME 下的 ~/.hermes 放 gateway_state.json、gateway.pid（裸整数）、gateway.lock、真实的 unix 套接字 gateway.sock，检出 ~/.hermes/hermes-agent 放 install-stamp.json 与 acp_adapter/gateway_server.py，旁边放 mode 000 的 .env、auth.json、config.yaml、state.db、SOUL.md：读取记录每个触碰的路径，全部在 GATEWAY_FILES/CHECKOUT_FILES、检出目录与 plist 之内，凭据文件一个都没碰也没有报错；字段解析正确（gateway_state、pid、start_time、hermes_home、code_sha、platforms、裸 pid 文件只得 pid）；launchctl 目标是 gui/<uid>/<标签>、ps 问的是记录的 pid；整条预检得 A，pid 死亡时按 launchd 得 D，plist 删掉后 E，更新标记 C，stamp 的 commit 不同 B；HERMES_HOME 优先（~ 展开为 HOME，此时不读 active_profile），active_profile 指向存在的 profile 目录时 home 与 launchd 标签随之改变，default/非法名/目录不存在保持根目录；非法 JSON 与非法 commit 为缺失事实；gateway.sock.path 指向 control.sock 时算有套接字；可执行文件在 <检出>/.hermes/bin/hermes 时读该检出，没有 gateway_server.py 的检出判为 in-process；检出不存在时 viewer 未知并按查看器判定 | planned |
| G032-NC33 | G032 | protocol | HermesControl 在 hermes acp 启动前运行网关预检：非 A 不启动进程并以 NATIVE_GATEWAY_UNAVAILABLE 拒绝，A 与 in-process 照常 | 注入 B、C、D、E 判定时 initialize() 以 NATIVE_GATEWAY_UNAVAILABLE 拒绝，消息等于 gatewayRefusalMessage（含“预检 <字母>”、解释与 Hermes 命令），之后 open() 与再次 initialize() 同码拒绝、healthy() 为 false，close() 返回 closed 且 exitCode/signal 为 null、protocolFailure 为同码；带 FIXTURE_CLI_TRACE 的夹具 CLI 从未被启动（trace 文件不存在），没有任何 ACP 帧；预检收到的环境是 options.env 与 launch.env 的合并（launch 优先）及可执行文件路径；注入 A 或 in-process 时夹具正常启动、建会话、回合完成，CLI trace 恰好记录两次 acp；既有的 Hermes 协议用例在注入 A 的前提下全部通过 | planned |
| G011-UP10 | G011 | integration | OpenClaw 官方升级顺序的跳数计算（ADR-052 实现裁决） | 按配方声明的桥接版本：已装版本早于 2026.7.0 且目标晚于 2026.9.5 时两跳 [2026.9.5, 目标]（2026.3.23-2 → 2026.10.9），否则一跳 [目标]（2026.9.36、2026.7.0 直达；目标就是 2026.9.5 时一跳）；已装版本未知或不可比较时以 INVALID_METADATA 拒绝，不猜；OpenClaw 配方声明的正是上游命令：gateway stop/start/status --deep、doctor --fix --yes、--allow-scripts=openclaw、node restart、backup create --output <目录> --verify、迁移 ~/.openclaw/openclaw.json | planned |
| G011-UP11 | G011 | integration | OpenClaw 顺序升级的正路：命令顺序、恢复判定与事实 | 确认框列出两跳、按序的命令原文、第一跳前停止的 Gateway、Gateway 恢复后由产品命令重启的 node 服务、备份命令、Doctor 改写的文件与 .bak 说明，rollback 为 null，node 服务不再列为“继续用旧版本”；检查不运行任何产品命令。同意（带 backupConfirmed）后替身记录的命令行正好是：gateway stop → npm install（--allow-scripts、公共注册表、精确版本）→ doctor --fix --yes（每跳）→ gateway start → gateway status --deep → node restart；没有 kickstart；Gateway 在第一次 npm 之前停止、在最后一次 Doctor 之后启动；恢复判定通过（新进程、端口监听）；hops、services、backupConfirmed、restartServices、actualVersion 如实记录，configurationMigrated 不出现；日志含每步命令原文、status 的末尾与“已核实本机程序为 <目标>”；任务 completed 且 resolvedVersion 为目标；事实原样读回 | planned |
| G011-UP12 | G011 | integration | 第二跳的 Doctor 拒绝 | Doctor 以非零退出并提到 2026.9.7 时任务 failed（DOCTOR_FAILED），错误带 Doctor 原话、已装入的版本与“没有回滚也没有重试”；hops 为 [{2026.9.5, installed, ok}, {目标, installed, failed}]，actualVersion 是磁盘上的第二跳版本，services 不出现，configurationPreserved 未确认；之后的命令（gateway start、status、node restart）都没有运行，Gateway 保持停止，没有 kickstart；结果已知，维护锁释放 | planned |
| G011-UP13 | G011 | integration | 某一跳的 Node.js 要求不满足 Gateway 或 node 服务的 Node.js | 确认框按跳列出要求：桥接跳全部满足，目标跳的 Gateway 与 node 服务都不满足且都算“随升级重启”（node 服务由顺序重启）；check.runtimes 是目标跳的；任务在改动前以 RUNTIME_INCOMPATIBLE 停下并指名那一跳的版本、服务与 brew upgrade 命令；没有运行 gateway stop，原版本不变，hops 不出现 | planned |
| G011-UP14 | G011 | integration | 没有备份确认的顺序升级 | 不带 backupConfirmed 的提交在创建任务之前以 BACKUP_CONFIRMATION_REQUIRED 拒绝（消息含备份命令，以“没有升级”结尾）；backupConfirmed: false 是 INVALID_INPUT；没有任何任务、没有运行任何命令、原版本不变；普通 npm 产品带 backupConfirmed 是 INVALID_INPUT；带确认的同一命令与不带的是不同指纹（COMMAND_CONFLICT），重复提交幂等 | planned |
| G011-UP15 | G011 | integration | Doctor 改写受保护配置记为迁移 | 2026 年 7 月之后的安装一跳直达；Doctor 改写 ~/.openclaw/openclaw.json 后任务仍 completed，configurationMigrated 为 ["~/.openclaw/openclaw.json"]，configurationPreserved 为 true（HarnessHub 自己没有写入），Doctor 的改写保留，其他受保护文件不变；日志写明由产品的 Doctor 改写、原件在 .bak 备份里 | planned |
| G011-UP16 | G011 | integration | gateway start 之后 60 秒内没有在端口上监听 | 任务 failed（SERVICE_NOT_READY），actualVersion 与磁盘都是目标版本，hops 全部 ok，services 只有 Gateway（restarted，ready false）；错误给出已安装的版本与重试指令（gateway status --deep、stop 后再 start）；status --deep 的末尾已写入日志；node 服务没有重启并在日志说明原因；没有 kickstart、没有重试；结果已知，维护锁释放 | planned |
| G011-UP17 | G011 | unit | 顺序升级的事实与同意的解析 | parseManagementJob 原样读回 hops、backupConfirmed、configurationMigrated 与 services；拒绝空的或超过 4 项的 hops、installed 为假却有 Doctor 结果、未知的 doctor 取值、多余字段、与 actualVersion 不符的 hops、非布尔的 backupConfirmed、空路径或超过 8 项的 configurationMigrated、带 hops 的 install 任务；parseManagementInput 只对带 expectedNativeFingerprint 的 upgrade 受理 backupConfirmed: true，false、字符串、install 或缺指纹都是 INVALID_INPUT | planned |
| G054-UP3 | G054 | e2e | OpenClaw 顺序升级的确认框与任务事实（ADR-052） | 确认框列出跳数与中间版本、按序的命令原文（含 --allow-scripts=openclaw）、Gateway 在第一跳前由产品命令停止、最后一跳后启动且期间渠道离线、不用 kickstart、node 服务由产品命令重启、Doctor 改写的文件与 .bak 说明、插件、只能从备份退回且没有 npm 退回命令；确认按钮在勾选“我已运行 openclaw backup create … 并核对了备份”之前不可用，取消勾选又不可用；提交带 backupConfirmed: true、同意的服务与这次检查的指纹；任务详情显示每一跳、Gateway 与 node 的结果、配置由 Doctor 迁移、HarnessHub 没有写入；无页面错误 | planned |
| G066-C01 | G066 | integration | v12 迁移夹具 × 7 种绑定来源（D1 形态、派发前失败、插入前拒绝、导入、分支、清空、“reset + D1”）升到 v13 | 迁移后 `mark` 只降不升、纪元跨绑定单调、need=∅ 为 synced；v12 构建以未知版本拒绝 v13；迁移失败整笔回滚、备份保留；崩溃注入后库可打开 | planned |
| G066-C02 | G066 | property | 随机生成的 v12 日志迁移到 v13；单一 (harness, control) 的 v12 会话迁移后再进行 20 轮 | `mark.throughSeq` ≤ 真实送达或亲历、只降不升，纪元跨绑定单调；该会话 20 轮 `dispatched === input` | planned |
| G066-C03 | G066 | integration | 写 `relay_packets` 时的 fold 校验：fold 单元指向未终结的 Run，或该单元的用户消息晚于当前输入 | 两种都被拒绝，本 Run 以 `RELAY_PREPARE_FAILED{reason:"render"}` 失败、Store 不进入 failed；单元已终结且用户消息早于当前输入时正常写入 | planned |
| G066-C04 | G066 | integration | 送达行转换：第 4 节允许表的全部转换、禁止转换、unknown→unknown 与 recorded→recorded 的同值写、无效样例 in_flight←recorded | 允许表全部通过；禁止转换被应用层拒绝；触发器对 unknown→unknown 同值写放行；无效样例（in_flight←recorded）被触发器拒绝 | planned |
| G066-C05 | G066 | integration | 故障注入：超长钉住、2 万文件、字段打满的中文摘要、ID 冲突、扫描器异常、同值写 | Store 均不进入 failed；预期内的接力失败只让本 Run 失败，不让 Runtime fatal、不波及其他会话 | planned |
| G066-C06 | G066 | unit | `assertSessionTransition` 的每条新规则各一个无效样例：非本绑定的 Run 改 `binding.relay`、`nativeEpoch` 回退、`epochFloor` 变小、同一纪元内 `mark.throughSeq` 在 clear 与 suspect 回退之外变小或低于 `epochFloor`、派发后改 `run.relay` 或 `contextReadyAt`、改归档绑定的 `relay`；写者 Run 的 `run.ended` 带与不带 `native.cleared` 时“归档 + 新建同 harness/control 绑定” | 每个无效样例都被拒绝；带 `native.cleared` 的归档放行，不带的拒绝 | planned |
| G066-C07 | G066 | integration | `relayWrite` 写懒重建的摘要、索引与 `relay_deliveries.realized`，同时有并发的 `transact` | `relayWrite` 不升 version，与并发 `transact` 不互相覆盖；写失败只记诊断、留待下次 | planned |
| G066-C08 | G066 | performance | 用最长合法值（`gateway:<253 字符主机名>`、最长 ID、pending 加 suspect prior）构造绑定与 Run 的接力字段并提交 | 快照增量每绑定 ≤1,024 B、每 Run ≤320 B | planned |
| G066-C09 | G066 | integration | 安装级 `relay_log` 写到 65,536 行时再追加；读写 `relay_prefs` | 同一事务轮转：每个 (vendor, scope, session_id) 只保留最新一行，其余移入 `relay_log_archive`；轮转后仍满时报 `consent_log_full`（受理时为 `409 RELAY_UNAVAILABLE`）；`relay_prefs` 只接受四个键、值 ≤64 字节 | planned |
| G066-C10 | G066 | review | `src/contracts/relay.ts` 与 C006 的 JSON Schema（交接单清单 `RelayPacket`、送达行 `DeliveryRecord`）逐项对照 | 类型与 Schema 等价、枚举一致；不一致即不通过 | planned |
| G067-C01 | G067 | integration | v12 推进规则的四种组合：due=∅；carried 且 recorded；carried 且 unknown（第一次与重发之后）；carried 且 not_recorded | 按 `advance ⇔ dispatched ∧ (due=∅ ∨ carried ∧ (input=recorded ∨ input=unknown ∧ 已重发一次))`：due=∅ 与 carried recorded 推进；unknown 第一次不推进、重发后推进（次数由 `run.ended.data.relayResendOf` 推出）；carried not_recorded 不推进 | planned |
| G067-C02 | G067 | integration | 单 Harness 对话里依次出现 `/export`、`/clear`、`model_not_applied`、Codex 无 turnId 的拒绝 | 每次之后的下一条 `dispatched === input`，不改发 JSON 信封 | planned |
| G067-C03 | G067 | protocol | 五家 Driver 的插入前拒绝、插入后失败与 `unknown_execution` | 插入前拒绝 → not_recorded；插入后失败 → recorded；`unknown_execution` → unknown，不自动重跑 | planned |
| G067-C04 | G067 | integration | 当前输入是全角前导空格的 `/clear`（“　/clear”） | 按 Driver 的 `classify` 判定，与原生解析一致（Hermes 先 `lstrip()` 再判为 `/clear`）：作为命令回合原样发送、不捎带，E3 不误判为 recorded | planned |
| G067-C05 | G067 | integration | 8 MiB 快照上同 Harness 续接、切换校验、blocked 后恢复，以 R6 的 66 回合长回复画像作固定用例；切到新目标时要发的全部来源仍超限 | 三条路径都不报 `CONTEXT_TOO_LARGE`；仍超限时提供“只发这条消息”（原样发送、不改 `throughRunId`） | planned |
| G067-C06 | G067 | unit | 命令回合的声明效果与执行结果组合：executed、not_recorded、noop | 命令效果只在 executed 时生效；not_recorded 或 noop 的命令回合不按声明效果转换 | planned |
| G067-C07 | G067 | integration | Run 以 unsafe 结束时存在待决切换与等待它的排队 Run；之后停止宽限到期 | 同一事务把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`、排队 Run 记为 `SWITCH_NOT_EFFECTIVE`，不悬挂；宽限到期后仍能 resume | planned |
| G068-C01 | G068 | integration | 20 轮零延迟假 Harness 对话，其间插入未派发回合、合成失败、`/export`、`/clear`、`/undo`、`attach:"none"` 与 WorkBuddy 目标 | 每一轮都 `dispatched === input` | planned |
| G068-P01 | G068 | property | 任意证据序列驱动四种同步状态，以 `relay-harness-peer.mjs` 维护的原生历史为参考模型 | `mark` ≤ 实际送达或亲历；回退不低于 `epochFloor`；旧包 present 不推进 pending 包；fresh 上任意命令序列之后 need 不变；4 × 13 没有未定义的格 | planned |
| G068-C02 | G068 | integration | pending 绑定收到下一条内容输入：可自动重发（autoResends=0）、自动重发已用尽、Driver 声明 `lateDelivery`、用户选 `attach:"none"` | 四种出路：自动重发一次；用尽后受理同步 `409 RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}`；`lateDelivery` 不自动重发；`attach:"none"` 原样发送、不改状态与水位 | planned |
| G068-C03 | G068 | integration | Hermes `/clear`：回复等于固定回执 `Conversation history cleared.`；回执不符之后下一次回放为空，或标记仍在 | 确认 → fresh{user_cleared}、`epochFloor` = 本 Run 的 `run.ended` seq、纪元 +1；确认不了 → `suspect{clear_unconfirmed}`，回放为空时才按清空生效，标记仍在则回到清空前的状态 | planned |
| G068-C04 | G068 | integration | 本纪元收到过交接单的绑定：送达后压缩游标变化一次；游标未变 | 游标变化时置 reanchor 一次，下一条内容输入附要点；游标未变不置位 | planned |
| G068-C05 | G068 | integration | 清空之后连续 20 轮；用户点“附上交接单”，附上的包结论 unknown 后重发 | 清空后 20 轮 `dispatched === input`；`relay.attach:"full"` 只对那一条忽略下限、一次性全量；resend 继承 `attachOverride` | planned |
| G068-C06 | G068 | integration | A 清空 → B 两轮 → 回到 A；A 清空 → native-reset → 首条内容输入 | 回到 A 只补交 B 的两轮；native-reset 后的首条仍不含清空前的历史（`epochFloor` 随绑定谱系继承） | planned |
| G068-C07 | G068 | integration | 保留进程开启时 Hermes `/undo` 之后的下一回合 | suspect 绑定不复用保留进程，先关闭再 open 回放核对；`mark` 回退（不低于 `epochFloor`），在同一会话补交 | planned |
| G068-C08 | G068 | integration | Hub 中途重启时未派发、已派发、送达已 recorded 的 Run 各一；另一个会话的 relay 行写入失败 | `recoverRelay` 按会话 SAVEPOINT：未派发 → `not_recorded{never_dispatched}` 并回到 prior；已派发 → `unknown{owner_ended}`；已 recorded 不改；写失败的会话只标 `relay_recovery_failed`，不影响其他会话 | planned |
| G068-C09 | G068 | integration | process 型 Driver 的回合以 unknown 结束，Hub 确认该回合的进程组已结束后用户选“继续原会话”（D6） | 只读 resume 并按 `DeliveryPosition` 核对：用户条目在 → synced{mark}，不在 → 回到 prior；need=∅ 原样续接；不重跑回合 | planned |
| G068-C10 | G068 | unit | 先 `/model X` 再 `/clear`，Claude 的 Driver 合成清空并回报 `BackendResult.native.replaced.checkpoint` | 旧绑定归档，新绑定 fresh{user_cleared} 并继承旧绑定的 `observed`；配置承接读同一 (harnessId, controlId) 当前选择纪元内最后一个已派发且 input≠not_recorded 的 Run（跨因清空归档的绑定），模型仍为 X | planned |
| G069-C01 | G069 | protocol | 六家的 `TurnText` 放置（两段 text、单 text、技能项 + 正文 + 余下原话）与首行省略：当前输入判为命令或疑似命令、当前输入含疑似密钥 | 各家按声明放置，第二段等于原话；两种情形都省略首行 | planned |
| G069-C02 | G069 | protocol | `deliveryPosition` 在 open 之后、派发前记录；`verifyDelivered(position, markers)` 按标记逐个核对，含超出核对窗口与迟到写入 | 按标记逐个回 present / absent / outside_window / compacted / unavailable；窗口没覆盖派发位置时为 outside_window；迟到写入时按本包标题行查到的上一包顺带改记 recorded | planned |
| G069-C03 | G069 | unit | `classify` 对半角 / 全角（U+3000）前导空格、路径（如 `/Users/…`）、别名、`unlistedSlash=text` 的输入 | 判定与各家原生规则一致；`unlistedSlash=text` 时恒为 content | planned |
| G069-C04 | G069 | unit | `resolveVendor` 四个夹具：Claude 用户设置里的 `ANTHROPIC_BASE_URL`、Codex 的 `OPENAI_BASE_URL`、dsh 工作区 `.env`、Ollama `*-cloud` | 都得 `gateway:<host>` 且来源层正确；值不出现在任何日志 | planned |
| G069-C05 | G069 | protocol | `BackendResult.native.cleared` 三家各一（Claude 合成 `session/new`、Hermes 固定回执、OpenClaw `sessions.get` 见新会话）与确认不了的路径 | 三家确认时回报 `native.cleared`（Claude 带 `replaced.checkpoint`）；确认不了时不回报 cleared，交给状态机记 `suspect{clear_unconfirmed}` | planned |
| G069-C06 | G069 | protocol | 回放导入的用户条目带四类原生包装：Claude `<bash-input>` / `<bash-stdout>` / `<local-command-stdout>`、Hub 附件指针、Hermes `--- Attached Context ---`、OpenClaw `[Working directory: …]`；本安装的交接单带 Driver 声明的前后缀 | `userTextOf` 剥掉四类包装，剥下部分记 external_output 只计数；交接单识别允许 Driver 声明的前后缀 | planned |
| G069-C07 | G069 | protocol | 因交接新建的会话回写原生标题：Codex `thread/name/set`、Claude `_session/rename`、Hermes `/title`；公共标题含疑似密钥 | 标题在 `session/new`（Codex `thread/start`）之后、首个提示之前回写；标题先经出境脱敏，有命中用“新对话”；Hermes `/title` 吞回执、不产生回合 | planned |
| G069-C08 | G069 | unit | `normalizeModel` 输入 `provider/model`、`<provider>:<model>`、别名与 null | 归一为去掉 provider 前缀与别名的模型键；null 得空串 | planned |
| G069-C09 | G069 | protocol | Driver 上报逐请求用量 `NativeUsage.requests`：正常、超过 64 条、不上报 | 有界上报（≤64 条）；不上报时记“未上报”，不算通过 | planned |
| G070-C01 | G070 | unit | 同一输入重渲染 100 次；不同 TZ / LANG 的子进程渲染 | 只得到 1 个 sha256；跨 TZ/LANG 字节相同 | planned |
| G070-C02 | G070 | unit | S1 交接单、A→B→A 增量、要点包三个样例场景渲染 | 与金样 `tests/fixtures/relay/golden/{s1-packet,s2-delta,anchor}.md`（终稿 5.6）逐字节一致 | planned |
| G070-P01 | G070 | property | 随机会话、档位与包类型下渲染交接单；请求带 `attach:"none"` | 每类事实 已渲染 + 已省略 + 未统计 = 全部；verbatim + compact + line + ranged + excluded = \|need\|；`attach:"none"` 不调用 `chooseBudget` | planned |
| G070-P02 | G070 | property | 500 个随机会话的增量摘要与重建（同一脱敏上下文；注入 earlyClose 与 storeDetail 失败） | 增量 = 重建，逐字节相同 | planned |
| G070-C03 | G070 | unit | W 在 4k–2M 上按对数均匀取样；contextUsed ∈ [cliff−5k, cliff+2k]；CJK 夹具 | 受理通过即不 blocked；`cliffCheck` 的越线判定与 projected 一致、不越线不降档；用户原话预算 U 按 token 计 | planned |
| G070-C04 | G070 | unit | 索引字段越界（`line.userHead` >360 B、`line.result` >64 B、`line.displayName` >64 B、`line.model` >128 B）；字段打满的摘要 | 按收紧次序截短，索引的 CHECK 2,048 B 只作断言；`bound()` 收紧到 ≤48 KiB | planned |
| G070-C05 | G070 | unit | 工具输出里 ANSI 着色切开秘密（`grep --color=always`）；不可信字符串含「」；最近一回合的错误原文 | N1 先整段删除 ANSI 序列后秘密可命中；不可信内容里的「」映射为﹁﹂；错误原文在“状态与风险”节内的 HH-DATA 区 | planned |
| G070-C06 | G070 | integration | 摘要记录命中区间后，已知秘密集合变小（令牌轮换后旧值仍有效）或变大，再重建与出境 | 集合变小后重建先套历史区间，曾被脱敏的位置仍被脱敏；集合变大不让摘要 behind（目标新带来的值只在出境复扫里补上） | planned |
| G070-S01 | G070 | security | RD-01：`env_key="CORP_LLM"` 取 40 位十六进制值，`printenv` 后交给 dsh | 出境、`relay_bodies`、事件中均为 0 次 | planned |
| G070-S02 | G070 | security | RD-02：从未交出的 `ZAI_API_KEY` 出现在 `~/.zshrc` 的回显里 | 0 次 | planned |
| G070-S03 | G070 | security | RD-03：秘密跨在“末尾 20 行”或 G2 头尾的切口上；另一例 ANSI 着色在秘密内部 | 不出现长度 ≥8 的子串 | planned |
| G070-S04 | G070 | security | RD-04：已知秘密以终稿 10.2 的 10 种形式出现（原值、JSON 转义含 `\/` 与 `\uXXXX`、URL 编码含大小写、表单 `+` 与双重编码、`'\''` 壳转义、折行、base64 三种对齐、十六进制）；postgres、redis 连接串 | 全部被替换，主机保留 | planned |
| G070-S05 | G070 | security | RD-05：128 个工具 × 64 KiB；另一例向扫描器注入异常 | 前者交接成功并在账目记“未扫描”；后者 `RELAY_PREPARE_FAILED{reason:"redaction_failed"}`，不派发 | planned |
| G070-S06 | G070 | security | RD-06：secret 输入与整条回复都是“hunter2” | RD-06a：出境字节、`relay_*` 表、`relay_log`、接力事件、日志与诊断中没有它的原值、sha256、sha1、md5；RD-06b：既有命令指纹 `sha256(JSON)` 登记为已知违例（终稿第 20 节 Q19），不作本用例的通过条件 | planned |
| G070-S07 | G070 | security | RD-07：pending 期间改了环境后重启；或删掉 relay-key | 生成新 ID 并带 supersedes，不出现 INVALID_DATA | planned |
| G070-S08 | G070 | security | RD-08：同一秘密出现在两个会话、交给两个厂商 | 两个会话的标签不同，不可跨会话关联；密钥文件的三种异常语义见 G070-S12 | planned |
| G070-S09 | G070 | security | RD-09：会话环境含 `AWS_PROFILE=default`、`ANTHROPIC_MODEL=claude-opus-5-5`；配无效样例 | 按名排除、不进已知秘密集合，`default` 与来源说明不被改写成标签；无效样例证明检查能拒绝错误 | planned |
| G070-S10 | G070 | security | RD-10：含 `/` 的 secret；令牌在 URL 路径里的 webhook URL；配无效样例 | 两者都被命中并替换；无效样例证明检查能拒绝错误 | planned |
| G070-S11 | G070 | security | 终稿 10.3 的全部注入用例与 IN-01–IN-06（IN-06 为「」槽）；转义模糊测试 10,000 例（核心 + 扩展 + 「」槽，变异对照） | 注入文本只出现在带作者标注的围栏或「」引用槽内，伪造的标记行被改写，〔 只出现在 Hub 框架行；核心与扩展性质零违例，5 种变异各被检出 | planned |
| G070-S12 | G070 | security | HMAC 密钥文件三种异常（长度不对；权限 0644 而属主是本用户；属主不是本用户或文件被替换）（RD-08）；当前输入含疑似密钥 | 长度不对拒绝使用并提示；0644 改回 0600、记告警、照常使用；属主不对则轮换、写新 `keyId`、放行记录失效并提示重新确认，摘要不 behind；第二段原样发送、省略首行，并给出卡片提示所需的命中计数 | planned |
| G070-C07 | G070 | performance | 256 Run、8 MiB、打满上限的中文摘要渲染；脱敏按秘密数 {20, 100, 300} × 10 种形式 × 文本类型；RunDigest ≥1,000 样本；`--expose-gc` 后的堆增量 | 定档 p95 ≤2 ms，组装 + 脱敏 + 哈希 p95 ≤10 ms，合计 p50 ≤5 ms、p95 ≤15 ms，额外堆 ≤8 MiB；精确匹配 + 形状规则 ≤3 ms/MiB、加熵规则 ≤12 ms/MiB；RunDigest 典型 p95 ≤2 ms、最坏 p95 ≤3 ms、p99 ≤8 ms；毫秒目标在参考机上跑并写进验证记录，CI 只断言计数类量 | planned |
| G070-C08 | G070 | review | 估算器 est/2 的冻结计数夹具（按模型 ID，记日期与分词器代次）与策略常量的变化 | 夹具的日期与分词器代次已登记；模板、转义表、脱敏规则、估算器系数、档位常量任一变化即升 `policyVersion` | planned |
| G070-S13 | G070 | security | 附件物化与 HMAC 密钥的位置（D5 推荐项）：会话带图片与文本附件跨厂商交接，数据根、工作区、附件物化目录与 relay-key 各取临时目录 | 附件物化目录按会话建在数据根之外（0700、名字不可猜测），后续回合原生会话仍能再次读取同一只读副本（ADR-023 语义不变），删除会话时一并删除；relay-key 不在数据根内；交给目标的路径与交接单正文里不出现数据根路径；任一目录与工作区按 (st_dev, st_ino) 相互包含时跨厂商交接在派发前失败 | planned |
| G071-S01 | G071 | security | WS-01–WS-06：过滤器名 `a=b` 与带点、process 过滤器、include、HOME 配置 lfs 与假 git-lfs、HOME 为仓库、gitdir 在外、Hub 环境含 `GIT_DIR` / `GIT_CONFIG_PARAMETERS` 与 API key、PATH 含工作区内目录时的假 git、数据根在工作区内（符号链接、大小写与 firmlink 写法、反向包含） | 过滤器、钩子与 fsmonitor 执行 0 次，include 那一例记 partial；`.git/lfs` 不变；不出现 `../`、不扫描 `.ssh`；gitdir 在外时拒绝观测；子进程环境恰为白名单；假 git 不被执行；数据根在工作区内时报 `data_root_in_workspace` 且观测结果不含 data；每条各附无效样例 | planned |
| G071-C01 | G071 | integration | 非 git 目录 2 万项 | 只存 1,000 项并记 partial | planned |
| G071-C02 | G071 | integration | 观测超过 250 ms | SIGKILL 整个进程组并等待退出；结果 `unavailable{timeout}`，不阻塞交接 | planned |
| G071-C03 | G071 | integration | 返回时 HEAD 与 `.git/index` mtime 未变且距上次观测 ≤60 s；其一变化或已超过 60 s | 前者复用上次观测行，后者重新观测 | planned |
| G071-C04 | G071 | performance | 3k 文件、2 万文件、大文件、冷缓存的合成仓库 | `observeMs` 分布写进验证记录：3k 文件 p95 ≤60 ms、2 万文件 p95 ≤200 ms、硬上限 250 ms | planned |
| G071-C05 | G071 | platform | macOS APFS 上以大小写不同与 firmlink（`/System/Volumes/Data/…`）写法给出工作区 | 工作区 realpath 一致 | planned |
| G072-C01 | G072 | integration | 空闲时切换到另一个 Harness，随后发送下一条消息 | 切换生效时不组包、不做预算、不启动目标；下一条消息受理后才准备目标绑定 | planned |
| G072-C02 | G072 | integration | 受理时可判定的每种拒绝：`RELAY_TARGET_UNVERIFIED`（`probed=false`）、`RELAY_UNAVAILABLE{data_root_in_workspace}`、`RELAY_CHOICE_REQUIRED`（含 `delivery_unconfirmed`）、`RELAY_CONSENT_REQUIRED{missing}`、按保守窗口判定的 `RELAY_INPUT_LIMIT` | 都在受理时同步返回（`RELAY_INPUT_LIMIT` 为 HTTP 429，其余 409），不建 Run、不启动进程，草稿保留 | planned |
| G072-C03 | G072 | integration | 执行中切换（S5）：长工具在跑且有待批准请求；用户选等这一轮结束，或停止并切换；停止未确认 | 默认 `wait_current` 到回合边界生效；停止并切换时审批关闭、不转交、工具不转移；停止未确认时 unsafe 的 `run.ended` 同一事务把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`、排队 Run 记为 `SWITCH_NOT_EFFECTIVE`，会话 blocked 后走恢复切换 | planned |
| G072-C04 | G072 | integration | open 之后失败：分类复核不符、vendor_changed、精化窗口过小、渲染失败 | Run 失败且未派发（`RELAY_PREPARE_FAILED{…}` / `RELAY_CONSENT_REQUIRED{vendor_changed}` / `RELAY_INPUT_LIMIT`）；新建的空原生会话与绑定保留，下一次按它 resume；relay 状态不变 | planned |
| G072-C05 | G072 | integration | 排在活动 Run 之后的消息，前一回合执行了 `/model` 或清空 | `prePlan` 时重做 admit；不通过的 Run 在启动前以同一错误码失败，没有进程，绑定不变 | planned |
| G072-C06 | G072 | integration | CS-01–CS-04：gateway 登录并设了 base URL、`local/qwen` 没有回环报告；目标为 `unknown:*` 时打开 `allow`、首次跨厂商按 Enter；已收过包的 OpenCode 原地换成 deepseek、回合中途换厂商；撤回后返回 A 且有增量，同时有待发重发与 LRU 缓存；另加工作区文件来源的端点与 `allow` 对四类前缀 | 记 `gateway:<host>`、不豁免；返回 409 且不记为同意；派发前 blocked 并记 `relay.vendor_changed`；blocked 给出三个选项、什么都不发出；工作区文件来源的端点每个会话都问；`allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*` | planned |
| G072-C07 | G072 | integration | A→B→A：热续接；冷且大；压缩后返回；返回核对时标记缺失；need=∅ 的 suspect（各种 cause） | 热续接在原会话发增量；冷且全程费用差 ≥ $0.10 或时延差 ≥10 s 时并列显示“新开并附交接单”；压缩后带要点；标记缺失且 need≠∅ → `RELAY_CHOICE_REQUIRED{cause:"marker_absent"}`；need=∅ 的 suspect 只对 legacy、verify_unavailable、vendor_changed、marker_absent 放行，其余先核对 | planned |
| G072-C08 | G072 | integration | 同意在 `run.authorized` 之后、`run.dispatched` 之前被撤回 | `run.dispatched` 事务内复读同意，已撤回 → 不派发，Run 以 `RELAY_CONSENT_REQUIRED{reason:"revoked"}` 失败 | planned |
| G072-P01 | G072 | property | 切换、消息、撤回同意的任意交错 | Session 身份不变，不出现两个活动 Run | planned |
| G072-S01 | G072 | security | 数据根在工作区内的三种写法（符号链接、大小写、firmlink）、反向包含与工作区内 `.harness-gateway.json` 标记查找；跨厂商与同厂商各一 | 都报 `RELAY_UNAVAILABLE{reason:"data_root_in_workspace"}`（跨厂商受理即 409）；同厂商可继续；该工作区的全部会话告警 | planned |
| G072-C09 | G072 | performance | 同一快照下 `relay.attach:"auto"` 与 `"none"` 的 ABBA 成对；假 Harness 启动延迟取 {0, 7 ms, 1.3 s} 三档；逐回合计提交、load 与事件 | p95(Δ_i − max(0, obs_i − start_i)) ≤15 ms；整份快照提交 −1；复用进程返回时 p95 ≤ 观测 p95 + 15 ms；每次交接新增事件 ≤3 条 + 同意镜像 1 条，普通回合 0 条 | planned |
| G072-C10 | G072 | integration | 在派发路径的每个提交点注入崩溃后重启 | 恢复后送达表、绑定与快照一致 | planned |
| G072-C11 | G072 | unit | `return-policy` 的 (R, k) ∈ {(80,0), (80,5), (300,0), (300,15)} 四点表驱动；生存估计；热判定 | 全程费用差与时延按公式；R̂、k̂ 取最近 50 个实现值的生存估计中位数，n<20 用先验并标注；热判定按最后一个请求的开始时刻；默认续接，从不静默改等级 | planned |
| G073-C01 | G073 | e2e | E1、E2、E3 三种证据路径；只有 E3 的 Driver 先收到第一条输出 | 派发时只放占位行“送达中”；证据到达后才画分隔线“从这里起由 X 接手”；只有 E3 的 Driver 首条输出时显示“已开始回复，送达待确认”且不推进水位；证据之前不出现“已接棒” | planned |
| G073-C02 | G073 | e2e | 交接卡：展开草稿、发送时拼接、附言、按轮排除与撤回、当前输入含疑似密钥、送达未确认且不能自动重发 | 写明“状态与文件改动按发送时的工作区生成”，内容变化时写“发送时已更新：原因”；写明撤回排除只影响尚未越过这些轮次的绑定；提示“这条消息里有 1 处像密钥的内容，会原样发给 X”；三选一为［再附一次］［只发这条消息］［新开原生会话］ | planned |
| G073-C03 | G073 | e2e | 执行中切换（S5）且有待批准请求；停止未确认 | 写明“批准或拒绝之前这一轮不会结束”并提供［等这一轮结束］［停止并切换］两个按钮；停止未确认时提示切换没有生效、引导恢复切换 | planned |
| G073-C04 | G073 | e2e | 清空命令之后：Hub 确认清空；清空未确认（Hermes 回执不符、OpenClaw 没看到新会话） | 确认后输入框上方显示“X 的上下文已清空 · 下一条不附历史［附上交接单］”，点“附上”后下一条带 `relay.attach:"full"`；未确认时显示“清空待确认 · 下一条消息发出前会核对” | planned |
| G073-C05 | G073 | integration | `/relay` 接口：列表、正文 ETag、preview（含 `observe=true`）、pins、exclusions、consents、prefs；跨会话读取 packetId | 正文 ETag 为 sha256；preview 只定档、不落库，`observe=true` 只在用户点“核实厂商”时调用；跨会话 404；SSE 推 `relay.input_recorded`、`relay.verified`、`relay.vendor_changed` | planned |
| G073-S01 | G073 | security | AP-01–AP-03：对 consents、pins、reveal 的跨源请求或缺 CSRF 的请求、读取其他会话的 packetId；排除后做增量、交给另一家、重发，按位置放行后同值出现在新位置；抓取全部 SSE 事件；新端点沿用 cookie、CSRF 与 Host/Origin/Sec-Fetch 校验 | 分别返回 403、404；被排除的轮次从不出现，新位置仍被脱敏；SSE 不含正文、原值，也不含原值的哈希 | planned |
| G073-C06 | G073 | unit | 用词检查扫描全部界面字符串与无障碍名（`web/src` 与 `src/web` 的文案、`aria-label`），含无效样例与例外清单（`Hermes Agent`、`Claude Agent` 这类注册表名、`子 Agent`） | 无效样例被拒、非零退出；例外清单生效；既有 11 处“我的 Agent”清零 | planned |
| G073-C07 | G073 | e2e | 费用显示：订阅、API key、越过价格悬崖 | 订阅只显示 token；API key 显示全程与每个后续请求的费用；越悬崖时提示［先压缩］［只发这条消息］［照发］ | planned |
| G074-C01 | G074 | integration | 确定性故障注入矩阵：假 Harness 按 Driver 声明（live / verify / lateDelivery / execution）× 证据序列（E1、E3、absent、outside_window、compacted、unknown 一次、unknown 两次、not_recorded、清空确认 / 未确认、回退、attach none）× 崩溃点 K1–K18 | 重复注入 0、丢增量 0；外来事实为空的纪元里 `dispatched === input` | planned |
| G074-C02 | G074 | e2e | S5、S6、S14、S15 的接力路径与崩溃注入 K1–K18（自 G056 移入） | 按终稿第 9 节收敛：待决切换失败而不悬挂；未知回合不重跑；gateway 型查看器被杀时绑定 unconfirmed、租约不交给他人；重启后 `recoverRelay` 的结论与送达表一致 | planned |
| G074-R01 | G074 | probe | RelayConformance P1–P14：六家在临时 git 工作区各跑一遍（最新正式版、最便宜的模型、独立凭据与消费上限） | 送达证据与第 8 节声明逐格一致；能回读的几家找得到标记；不出现 `CONTEXT_TOO_LARGE`；P2、P3、P6、P11 通过后翻转 `probed=true`；结果写进 `docs/verification/relay-conformance-<日期>.md` | planned |
| G074-R02 | G074 | probe | P15 真机零注入：Claude、Codex 各 20 轮单 Harness 对话，含 `/clear`、压缩后、外部编辑后各一例 | 从原生转录读回的每条用户输入与原文逐字节相同 | planned |
| G074-R03 | G074 | probe | P14 厂商键四个夹具（Claude 用户设置 `ANTHROPIC_BASE_URL`、Codex `OPENAI_BASE_URL`、dsh 工作区 `.env`、Ollama `*-cloud`）；P16 process 型继续原会话（Claude、Codex 各一次回合中杀 Hub） | 目录缓存与 open 后观测一致，四个夹具都记为 `gateway:<host>`；确认进程组结束后只读 resume、核对位置、继续对话，只读打开不触发任何回合且下一条原样 | planned |
| G074-C03 | G074 | performance | RelayBench-X 进 CI：48 个合成会话 + 12 个临时工作区真机会话 + 原型的 256 Run 画像与打满上限的中文摘要 | 改动文件召回 ≥0.98（git）、≥0.90（非 git）；命令与退出码、失败 1.0；省略账目恒等式 100%；确定性 100/100；增量与重建 500/500 一致；est/2 对冻结夹具整包误差 p90 ≤20%；脱敏夹具漏检 0、形状规则召回 ≥0.98、误报 ≤1% | planned |
| G074-C04 | G074 | review | RelayBench Q 的预注册：假设 H1–H9、功效分析、序贯设计与预算 | 预注册写入 `docs/verification/relay-bench.md`：v0（72 配对）只作 −10 pp 初筛，正式采纳需 ≥300 配对、−5 pp（D10）；预算另批，独立凭据并设消费上限 | planned |
| G074-C05 | G074 | review | 基准机器指纹与终稿第 11.1 节每行目标的实测 / 推算标注 | 每行目标都标明实测或推算并与验证记录对账；毫秒目标只在参考机上跑，CI 只断言计数类量 | planned |
| G075-C01 | G075 | performance | 8 MiB 快照上从受理到派发；逐回合计提交与 load 次数 | 受理→派发 p95 ≤400 ms 写进验证记录；提交次数与 load 次数有基准并逐回合断言 | planned |
| G075-C02 | G075 | integration | 按 version 缓存已校验的快照：version 变化；并发事务 | version 变化即失效；并发事务不读到旧快照 | planned |
| G075-C03 | G075 | integration | 跳过未变的终态 Run 校验时提交一个无效转换（无效样例） | 无效转换仍被拒绝 | planned |
| G076-C01 | G076 | probe | v1.1 通道探针 P-F1–P-F3、P-S1–P-S2、P-E1–P-E2、P-R1–P-R2 | P-F1 读取不弹审批；P-F2 `inside_workspace` 时不给路径；P-F3 撤回后供给停止且文件在下一次回收前删除；P-S1 两次新会话字节相同；P-S2 正文自足；P-E1 时延 ≤1 s/1.5 s；P-E2 拒绝不推进；P-R1 只读打开后网关无新回合；P-R2 未结算时保持 blocked | deferred |
| G076-C02 | G076 | integration | 撤回同意后文件视图的供给 | 先提交“停止供给”，再留墓碑并删除文件；跨文件系统不能原子，以墓碑为准 | deferred |
| G077-C01 | G077 | probe | v1.2 探针 P-M1–P-M4 | P-M1 残留进程 = 0；P-M2 argv 用脱敏规则扫描命中 0；P-M3 工具规格指纹跨恢复不变；P-M4 拉取率（细节题）≥60% 才改该接收方的默认档 | deferred |
| G077-C02 | G077 | security | shim 的 argv 与工具规格 | 用脱敏规则扫描命中 0；规格零凭据、只读 | deferred |
| G078-C01 | G078 | unit | 品牌 ID 与 `HostCapabilities` 的解析：空字符串、超长、含控制字符、未知枚举值、缺项 | 无效样例全部被拒绝；缺项按最保守值（`one_per_process`、`launch_cwd_only`、`reopen.cost: unknown`、`idleActivity: unknown`、`foreignTurns: undetectable`、`probed: false`） | planned |
| G078-C02 | G078 | unit | `resolveHostBudgets`：默认值、每个参数的上下界、非整数、`maxPinned` 大于 `maxHosts`；声明文本扫描产品名 | 越界与非整数拒绝而不是调整；`maxPinned ≤ maxHosts`；声明里没有产品名 | planned |
| G079-C01 | G079 | integration | 同一对话连续三回合（真实存储、真实子进程夹具、真实租约），选择不变、无不新鲜条件 | 第 2、3 回合复用同一宿主，Run 记 `reused: true`，事件 `native.session_reused{basis: same_owner_no_foreign}`；只启动一次进程；宿主在回合之间为 idle 且不持租约 | planned |
| G079-C02 | G079 | integration | A→B→A：切到 B 时 A 的宿主状态；回到 A 时的新鲜度判定与欠交补发 | A 的宿主转 idle 而不是关闭；回到 A 续用（无不新鲜条件）或按原因重开；A 只冷启动一次；接力的送达结论不变 | planned |
| G079-C03 | G079 | integration | 两个对话同一工作区同一类：对话 1 结算后对话 2 发消息；再回到对话 1 | 对话 2 取得租约并租借同一宿主为自己的会话打开；对话 1 的会话不受影响；每类最多 1 个空闲宿主；租约只在回合期间被持有 | planned |
| G079-C04 | G079 | unit | 新鲜度判定表每条一个无效样例：原程序里继续过、结果未知、绑定 unconfirmed / forking、接力 pending / suspect、`contextEffect` 为 clear / rewind / unknown、配置指纹变化、安装指纹变化、启动参数变化、工作区身份变化、宿主不健康、`foreignTurns: undetectable`；以及全不命中的正例 | 每个样例给出对应的 `StaleReason`，正例为 fresh{same_owner_no_foreign}；`compact` 不算不新鲜 | planned |
| G079-C05 | G079 | integration | 类上限（重且可收回的类活会话 ≤3、重且收不回的类进程 ≤3）或内存预算 `hostMemoryBudget`（假宿主报告的进程树 RSS）已满：存在空闲会话、空闲宿主、固定宿主、正在回合的宿主各若干，新回合到来；再把可收回者全部占满 | 先收回最久未用的空闲会话（记 `native.session_closed{reason: "evicted"}`），再关最久未用的空闲宿主（`native.host_closed{reason: "evicted"}`），重的类先于轻的类；固定与正在回合的从不被结束；无可收回者时回合等空位并可见（`run.waiting{kind: slot}`），不拒绝 | planned |
| G079-C06 | G079 | integration | 开启保持的对话有后台活动时切换 Harness；另一对话同工作区发消息；用户选择结束后台进程 | 固定宿主不因切换关闭并继续持有租约；另一对话得到 `WORKSPACE_KEPT`；用户结束后走停止链、记 `ended_by_user`，另一对话继续 | planned |
| G079-C07 | G079 | integration | 假时钟：池内空闲宿主到 `idleTtl`；固定宿主在“没有回合也没有原生事件”30 分钟、以及自上一回合起 4 小时硬上限 | 分别以 `idle` 关闭并记 `cleanup`；有原生事件时固定宿主的空闲计时重置但硬上限不重置 | planned |
| G079-C08 | G079 | integration | 回合进行中杀掉宿主的进程组；清理未确认的变体 | Run unknown、对话 blocked、宿主 dead 不进池；该绑定判 `unknown_outcome` 不被任何宿主复用；清理未确认时租约隔离；不自动重跑 | planned |
| G079-P01 | G079 | property | 随机的租借、归还（settled / pin / unknown）、淘汰、关闭、所有者崩溃序列，带 seed | 任意时刻每个原生会话至多一个持有者；宿主总数不超过 `maxHosts`；从不淘汰 leased 或 pinned；每个宿主的关闭都有原因与证据 | planned |
| G080-C01 | G080 | integration | 宿主未登记就尝试承载回合（无效样例）；登记写入被注入失败 | 前者被拒绝；后者回合以 `HOST_REGISTRY_FAILED` 失败且宿主关闭、留 `cleanup` | planned |
| G080-C02 | G080 | integration | 另起一个所有者进程登记 idle、pinned、leased 三种宿主（真实子进程）后被 SIGKILL；新所有者启动 | 三种宿主的进程组都被识别并结束，结果 terminated / gone / unconfirmed 记入事件；pinned 的租约按 ADR-030 释放或隔离；leased 的 Run 仍 unknown 但带“进程组已结束”证据；unconfirmed 不释放任何租约 | planned |
| G080-C03 | G080 | integration | v13 库迁到 v14：只加表、快照不变；迁移前备份；v13 构建打开 v14；迁移中途注入失败 | 快照字节不变；备份存在且只保留 2 份（ADR-049）；v13 构建以未知版本拒绝；失败整笔回滚、备份保留 | planned |
| G080-C04 | G080 | platform | macOS 上对真实进程组采样 RSS（`ps -o rss= -g`）；进程已退出、`ps` 超时的变体 | 采样值为正整数字节；退出或超时记 null 而不是抛错；输出不含路径与环境值 | planned |
| G081-C01 | G081 | protocol | 固定对端上同一连接打开两个会话：各自 open、prompt、close；第二个会话用 `session/load` 与 `thread/resume` 两种形状 | 两个会话各自得到正确的回复与结算；关闭一个不影响另一个；连接只启动一个进程 | planned |
| G081-C02 | G081 | protocol | 同连接两个会话各有回合时，对端穿插发送带另一会话 ID 的事件与附着的子线程事件 | 事件只归属持有该会话租借的 Run；附着的子线程与他人的会话只计数、不归属 | planned |
| G081-C03 | G081 | unit | 七家的 `HostCapabilities` 声明：扫描产品名；缺项；`probed` 的初值 | 声明不含产品名；缺项按最保守值；`probed` 全部为 false 直到探针记录登记 | planned |
| G082-C01 | G082 | integration | `GET /api/v1/native-hosts` 在有空闲、固定、正在回合的宿主时的返回；结束宿主的命令与界面语义 | 字段齐全且不含路径、环境变量值与会话内容；结束宿主经同一应用入口、走停止链并返回证据 | planned |
| G082-C02 | G082 | e2e | 浏览器：连续两回合后的复用说明；模拟原程序里的新回合后的重开说明；设置页的按类预算与保活时限只读显示 | 说明文案出现且称 Harness；设置页没有预热开关，预算与保活时限按类显示并注明是起点 | planned |
| G083-R01 | G083 | probe | H1 复核：发一条最便宜的提示后回合期间与之后空闲 10 分钟的进程树 RSS（每分钟采样），与 2026-11-03 未发提示的数字对照 | 每家一行实测数字写进验证记录；回合期间的峰值与空闲回收的时刻记录 | planned |
| G083-R02 | G083 | probe | H7 补测与 H3：发过提示的会话在进程重启后的 load/resume（Codex `thread/resume`、OpenClaw `session/load` 与 `session/resume`、dsh、Claude、OpenCode 的用时）；同宿主两个会话并发回合（最便宜模型，≤2 回合/家） | 每家记录接受 / 拒绝 / 未知与用时；Codex 与 OpenClaw 对发过提示的会话能否恢复有结论；归类表据此定稿 | planned |
| G083-R03 | G083 | probe | H4：发过提示后在原程序里加一回合，Hub 按声明的检测方式（列表 `updatedAt`、回合数、回放计数、`chat.history`）判定；Hermes 与 OpenClaw 的 cwd 是否生效由工具调用的工作区核实 | 每家写明外来回合能否被检测与依据；不能检测的声明为 `undetectable` | planned |
| G083-R04 | G083 | probe | H6：后台任务运行中结算，读 `unattributedUpdates` 与进程组成员 | 记录“结算后无未归属事件”是否等价于“没有后台活动”；不等价时该 Driver 的 `idleActivity` 定为 `background_possible` | planned |
| G083-R05 | G083 | probe | H8 补测：生产关闭链（1.5 s 宽限、先 EOF 再按 pid 加启动时间核对离组后代）下六家的关闭用时与离组后代的退出；持久 TMPDIR 下的冷启动与首个会话各 5 次；Pi 在开发策略 `--allow-unofficial` 下的 `switch_session`（只读研究） | 数字写进验证记录并标明版本；离组后代在 10 s 内是否自行退出有结论；预算与宽限的默认值据此校准 | planned |
| G084-C01 | G084 | property | 500 个随机会话（含分支、切换、压缩标记、接续）的记录树：增量投影与从头重建 | 逐字节相同；叶子只能移到已存在的记录；记录只追加 | deferred |
| G084-C02 | G084 | integration | 线性会话与带 `origin.history` 的分支、接续会话迁移成记录树；1 GiB 合成库 | 迁移后投影等于迁移前快照；来源历史变成父指针或标记而不再复制；接力表的 Run 键不变；时长写进验证记录 | deferred |
| G079-C09 | G079 | integration | 保活：宿主 initialize 之后没有会话时保活到按类时限；回合在取得工作区租约之前尝试取得租借；任何预热路径（无） | 对端夹具计数 `session/new`、`thread/start` 在保活期间为 0；没有租约的租借请求被拒绝；原生会话只在取得租约的回合里建立；无会话的宿主到时按 `idle` 关闭 | planned |
| G085-C01 | G085 | integration | 真实子进程夹具在 stdin EOF 后分别 0.3 s、1.2 s、2.5 s 退出；关闭宽限 1.5 s | 前两者不收到任何信号、`cleanup.stage: "eof"`；第三者在 1.5 s 后收到 SIGTERM（`stage: "sigterm"`），不响应则 SIGKILL；关闭用时记入证据 | planned |
| G085-C02 | G085 | platform | macOS 上宿主启动两个自成进程组的后代（一个随 EOF 退出、一个存活 3 s）；关闭时按 pid 加启动时间核对 | 已退出的不计残留；存活者在 10 s 内复查到退出后 `outside.remaining` 为 0；全程不向离组后代发信号；pid 被复用的进程不被认错 | planned |
| G085-C03 | G085 | integration | 两个工作区、同一 Harness 的宿主各自的 TMPDIR；同类第二个宿主复用同一目录；目录被改为符号链接或 0755 | 目录按类隔离、0700、与数据根互不包含；同类复用同一目录；符号链接或权限不对时回合以 `HOST_TMPDIR_FAILED` 失败并关闭宿主，不跟随链接 | planned |
| G085-C04 | G085 | integration | 安装指纹变化（升级）后首次启动；7 天未用的目录；超过 256 MiB 的目录分别在有、无活宿主时 | 升级后目录被清空再使用；陈旧目录在 Hub 启动时删除；超限目录只在该类没有活宿主时清空，删除失败只记诊断不影响回合 | planned |
