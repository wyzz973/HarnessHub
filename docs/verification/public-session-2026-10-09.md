# 公共Session、历史与Harness切换验收

日期：2026-10-09。本机macOS、Node25.9.0、pnpm10.12.3、TypeScript5.9.3。基线ac9850e；本次源码与本记录同次提交。范围按[ADR-010](../decisions/0010-public-session-mvp.md)与[切片契约](../contracts/public-session-mvp.md)。

## 交付

- 公共Session/Run/消息/命令/切换身份分离；SQLite聚合快照和append-only事件，同事务/CAS/非空日志提交，随后发布。命令重试返回原身份、不重复派发；已有消息/终态/command关联不能删除、改写或交叉。
- owner.sqlite主进程长期EXCLUSIVE OS锁，业务库WAL/FULL；路径身份、锁事务、generation、owner token均核对。跨数据根同canonical工作区独立排他；未确认的遗留writer保留quarantine，不按PID杀、不因TTL接管。
- 完整有界公共历史，逐Turn新原生连接，明确public_context_rehydrate；未来/排队输入不进入当前prompt，取消/失败历史保留状态。超限拒绝，不自动摘要/截断。
- 手动A→B→A与busy wait_current；请求前准入输入先用原Harness，请求后输入绑定switch ID，失败时明确未派发。旧writer与目标准备确认关闭后才effective，epoch/watermark/sourceRunIds保持可查证。
- chat连续入口、:harness/:cancel/:history/:quit；sessions list/show/events只读，不获取owner或恢复状态；sessions close持久关闭准入而不删历史。独立入口可用同Session ID续接。
- 原始stdin2MiB、输出记录/缓冲16MiB，Store日志32MiB与读取预算；在途创建验证最多16个并纳入可等待shutdown。退出收敛资源后释放数据根owner，关闭自有输入handle。

## 实际执行

| 命令 | 结果 | 证明范围 |
|---|---|---|
| pnpm test | 257项通过，无跳过，严格构建通过 | 旧目录/控制回归与新领域/SQLite/owner/workspace/IPC/CLI/输入输出 |
| pnpm test:real:session | 1项通过，无跳过 | 真实Codex0.160.0，3轮公共对话，2个独立chat进程，本地模拟Responses Provider |
| pnpm test:real:codex | 1项通过，无跳过 | 旧单次调用入口的真实Codex+本地模拟Provider回归；共享composition抽离仍兼容 |
| python3 -m unittest discover -s tools -p 'test_*.py' -q | 31项通过 | 工程检查器接受/拒绝，不计为业务测试 |
| python3 tools/check_design.py --write --verify-cache | 通过 | 原子文件owner、切片授权范围、DAG、生成/链接与基线缓存 |
| git diff --check | 通过 | 修改格式 |

真实数据、Session数据库、请求正文、私有配置与目录都用测试自有临时路径，不提交运行数据或个人凭据。工程任务完整蓝图仍部分planned/in_progress，不能把本切片验收勾成全项目完成。

## 正式入口证据

合成完整入口保持真实SQLite、SessionRuntime、DirectoryBindingFactory、ACP/Codex Driver、子进程和工作区lease，只替代外部Harness。

通过一条公共Session执行ACP A→Codex B→ACP A，再独立重开第四轮：公共ID始终相同，原生连接每次新建，旧关闭确认先于下一writer；epoch1→2→3；实际发送的后续prompt包含A/B历史，重开第四轮收到前三轮内容。管理读取/显式关闭不启动Harness。

真实厂商验收使用本机真实Codex与自有127.0.0.1 Responses SSE服务：第一chat进程两轮，第二chat进程同公共ID第三轮；Provider收到完整前序user/assistant和当前输入，恰好3次请求。配置与key为测试合成，workspace无任务写入，临时资源已清理。

这是“真实Harness+模拟Provider”的公共Session验收，不是实际外部模型质量验收。双真实厂商A→B→A尚未通过；不同Provider的注册/热切换未实现。

## 独立复核与修复

1. 续接配置比较受对象key顺序影响，合法同路径误报冲突。改为领域解析归一化后比较，保留工作区/manifest变化拒绝。
2. 非JSON入口监听旧message.delta而实际事件为run.output，导致看不到流式正文。已改并有正式人读CLI回归。
3. Runtime.close未等待create的外部validate资源。现跟踪最多16个pending，并等待finally清理；成功Store.create后才登记managed Session，publish重入关闭仍只一个Promise。
4. 无换行输入可以绕readline后的预算，慢stdout/反复history能积累数百MiB。原始块守卫在readline前，有界Writer统一全部输出；输入超限无需父EOF即可退出、Session不新增Run。证明基于错误/数据/资源，不用易漂移RSS阈值当唯一断言。
5. 领域数据可共享消息ID、input/text不匹配、command交叉、queued带执行证据、seq重复、context未来来源。强关系与反向映射已拒绝；历史转换也禁止形状合法的删除/改写。空事件写入不能推进版本或状态。
6. 切换失败后新输入可能被旧Harness执行的风险。现在输入绑定awaitingSwitchId并明确SWITCH_NOT_EFFECTIVE；请求前输入FIFO执行，未来取消输入不提前进入旧context，来源与生效水位有barrier测试。
7. 重复终态负例原先两次单独write依赖OS合包时机。某次集成发现关闭后帧按契约忽略，测试本身有竞态。已将负例两帧同小write提交，保留错误断言，没有睡眠重试或放宽结果；生产wait/关闭行为未因此改变。

额外覆盖真实SQLite写失败回滚且未提交不发布、终态发布失败保留事实但停止后续派发、active取消/late completed事实区分、旧owner暂停仍排他、SIGKILL恢复unknown不重跑、路径/锁事务失效、workspace跨根排他/quarantine、读历史不接管owner、取消queued不启动、目标初始化期间新输入的因果边界。

## 限制

目前是本机命令行公共会话，默认控制初始化10秒、执行30秒；完整预算配置、HTTP/图形UI、自动最优Harness选择、Provider管理/切换、原生resume、未知writer带证据恢复仍后续实现。configHome只固定引用，内部Provider/model内容不作为不可变模型快照；manifest内容则固定SHA-256。

不声明任意Harness的工具全部被网关强制审批、不声明外部程序不能改工作区，也不把原生completed等同任务正确性。公共cancelled与backend.status分开：撤回与晚到completed可同时存在，不能据公共标签声称后端未执行。43产品目录仍不是43个真实运行通过。
