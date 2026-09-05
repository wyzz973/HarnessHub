# 0004：文件任务、严格恢复与本机接入修复

状态：accepted。日期：2026-09-05。

## 问题与决定

比赛任务需要读取输入文件、产生可判分文件，纯文本完成状态无法证明结果正确。Run 增加声明式 `outputs`；Gateway 在回合结束后、公共终态之前采集指定文件，复制为不可变 Artifact 后提交元数据。采集计入总 deadline，取消后不登记迟到产物；文件缺失单独记录，执行状态与任务分数仍分开。不遍历全部工作目录，也不收集符号链接或越界路径。

Benchmark 增加版本化 `fixtureFiles`、JSON 结构等价和二进制 SHA-256 评判，保存可重评的证据及必需产物清单。输入文件、目录结构和归属在执行前后核对；权限策略由 CLI 明确选择 `deny` 或 `allow-once`，实际决定仍通过 Runtime 持久化和 Worker 确认，不增加另一套执行循环。

ACP 恢复采用显式 `acp.sessionMode: resume`。首次后端 ID 与来源事件必须原子提交并 ACK，随后才允许发出模型 prompt；恢复前同时核对公共 ID、后端 ID、checkpoint、cwd 与固定 argv。复用 acpx persistent 的 `same-session-only`，恢复失败不创建空会话。新增 idle suspend API 释放 Worker 并保留 Session；用户通过新 Run 恢复，不自动重跑旧任务。执行中断的未知结果继续遵循现有 interrupted/关闭策略。

增加只读安装快照和 `engine.usage` 事件。快照记录启动文件 hash 与可识别的所属包版本；已观测模型、累计 usage、单次 usage 和未知值区分保存，不从累计值推算本次成本。启动快照必须可取消，迟到的只读结果不能启动 Worker。

## 接入取舍

OpenCode 原免费模型出现 HTTP 429，不靠重复执行或静默降级处理。新增独立 `opencode-deepseek` Profile，复用已有 DSH DeepSeek 文件引用，模型和 max reasoning 显式配置，原 OpenCode 用户配置保留。Pi 也使用现有 DeepSeek 引用；launcher 只在子进程环境解析密钥，私有偏好文件不含秘密。

OpenClaw 当前原生 DeepSeek 调用已正常，ACP Bridge 的默认 `acp:<uuid>` 与其内部会话分类冲突。薄 launcher 使用独立 `agent:main:harnesshub:<uuid>`，避免复用用户主会话；不为这个进程内映射声明恢复能力，不修改其常驻 Gateway。

## 代价和验证

产物采集有数量/字节限制，并拒绝不安全或采集中变化的文件；它不是 OS 文件系统沙箱。下载默认 attachment、nosniff 和 sandbox，防止生成的 HTML 作为 Gateway 同源应用运行。

保持 Node/TypeScript 架构，不引入新进程运行框架。Windows 的 ACL、链接、文件句柄及进程树行为必须后续原生验证。接口、上限、兼容和具体证据分别由 [文件产物](../file-artifacts.md)、[恢复说明](../session-recovery.md)、[Benchmark](../benchmark.md)和 [本轮验收](../verification/2026-09-05-file-tasks-and-recovery.md)拥有。
