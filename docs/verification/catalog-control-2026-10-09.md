# 目录 v2 与受控控制连接验证

日期：2026-10-09。本机 macOS，Node v25.9.0、pnpm10.12.3、TypeScript5.9.3。范围按[ADR-009](../decisions/0009-catalog-control-slice.md)与[契约](../contracts/catalog-control.md)；没有公共Session/历史/切换实现。

## 已实现

- 固定42条稳定ACP源、44个分发入口，与原生Codex/Pi/OpenClaw显式合并后为43产品、47控制描述。保留版本、来源、原始/归一化SHA-256和许可证；不猜未知npm包bin、不启用preview或下载安装。
- 严格v2描述、v1校验后迁移、独立安装/控制覆盖。默认discover为schemaVersion2，--legacy保留schemaVersion1与旧first-valid语义。
- 有界nvm/fnm/mise/Volta/pnpm及产品安装目录；多个安装和canonical入口去重；PATH默认损坏不隐式替代；配置线索与程序分开；已有npm包身份/bin/Node解析。Python包身份仍明确未验证，需指定已有控制入口。
- 通用ACP、Codex App Server初始化、原生对话、文本/工具事件、拒绝权限、取消与关闭。单连接一个active run；后端结束、停止回执、进程清理和协议故障独立报告。
- 正式catalog/discover/probe/run:harness命令。默认配置和工作目录隔离，过滤宿主秘密；不自动换Harness/模型或重试未知结果。Pi RPC Driver后续实现。

## 实际检查

| 检查 | 结果 | 证明范围 |
|---|---|---|
| pnpm test | 150项通过，无跳过；包含严格构建 | 领域、真实文件系统、协议子进程、编译后CLI |
| pnpm test:real:codex | 1项通过，无跳过 | 正式CLI→真实Codex0.160.0→本地确定性Responses SSE Provider |
| python3 tools/check_design.py --write --verify-cache | 通过 | 唯一owner/切片范围/依赖/生成/链接及基线来源缓存 |
| python3 -m unittest discover -s tools -p 'test_*.py' -q | 31项通过 | 工程检查器的接受与拒绝；不算Harness测试 |
| pnpm catalog与默认discover的JSON读回 | 43产品/47描述，protocolProbesRun=0 | 固定目录与只读发现，不算协议接入 |
| 正式probe --harness codex --json | 协议响应；closed=true、protocolFailure=null | 实际Codex握手及资源关闭，不含模型调用 |
| 正式probe --harness gemini --json | gemini-cli0.62.0响应；closed=true、protocolFailure=null | 实际Gemini握手及资源关闭，不含prompt/认证验收 |
| 正式probe --harness opencode --json | 未通过：进程SIGKILL；资源清理收敛 | 本机该入口启动失败，原因未验证，没有换另一安装冒充成功 |

真实程序报告含机器路径，仅保存在忽略的.tmp；不提交报告正文或个人配置。实际协议版本信息优先于安装目录名字里的版本线索。

## 关键缺陷与回归

独立复核找出并修复：

1. 只有Pi ACP包装器时误用产品整体安装证据满足原生pi依赖。现在对每个required程序独立枚举，并覆盖仅包装器/无原生程序的拒绝用例。
2. cleanup期间过早移除SIGINT/SIGTERM监听，导致CLI先被杀、detached Harness残留。现在监听保持到全部清理完成；真实TERM-resistant子进程回归在stdin结束确认进入清理后发送SIGTERM，核对cleanup、PID消失和临时目录为空。
3. 收到completed后遇重复终态，内部连接故障被成功结果掩盖。现在保留首次BackendResult事实与资源closed事实，同时报告protocolFailure并非零退出；两协议均有正式CLI回归。
4. 控制初始化的私有CODEX_HOME未创建导致真实Codex退出。默认私有配置目录现已显式创建，再次正式probe通过；显式提供的配置根不由CLI删除。

测试同时覆盖描述未知字段/冲突/限额、包身份与越界、同名与多安装、空/非法UTF8/分片/超大帧、累计16MiB wire上限、请求/执行期限、未知/重复回应、身份串线、权限实际拒绝选项、取消先于turnId、终态先于start ACK、消费者异常、active close、TERM→KILL与自有进程组后代清理。回调、run result和close均有错误传播。

## 真实Codex与模拟Provider证据

测试使用自有127.0.0.1 HTTP服务、临时HOME/CODEX_HOME配置与dummy key；没有使用个人登录或真实模型。核对仅1次POST /v1/responses、指定model、原用户prompt、stream=true；返回固定文本，由真实Codex产生Native turn、流式文本和completed。确认无工具/权限事件、工作目录空、自有临时目录空，服务端socket/端口及目录均finally关闭。

这是“真实Harness+模拟Provider”的正式入口验收；不是全组件模拟，也不是“真实模型已通过”。默认pnpm test不运行此显式测试；需要本机Codex，缺少时失败而不标skip通过。

## 尚未验证/尚未实现

42上游产品并未逐个安装或执行；真实Claude包装器、OpenCode正常启动、真实外部模型与任意Provider组合没有通过证据。客户端fs/terminal能力没有声明；Driver默认拒绝所收到的审批不代表能强制覆盖外部Harness所有内建工具。

公共Session、持久消息/事件、跨连接执行权与恢复、上下文接续、A→B→A、自动最佳Harness分配、Provider切换仍需S03之后的实现。当前原生对话与NDJSON不可冒充持久公共事实或任务正确性。
