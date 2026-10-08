# 公共 API 与入口契约

状态：proposed，尚无 HTTP 服务。以下为可评审契约，不是可运行接口。Session 是公共稳定身份；原生 thread/session 不接受用户直接填写。

## 入口分层

认证 → 大小/格式/schema 校验 → principal 与 scope 校验 → 应用命令 → 所属聚合持久接收 → 响应。后台处理通过 outbox 继续；返回 202 不表示已经启动或完成。

| 方法与路径建议 | 语义 | 幂等与前置 |
|---|---|---|
| POST /v1/sessions | 建立公共 Session、工作区和选择偏好 | principal 范围 Idempotency-Key |
| GET /v1/sessions、GET /v1/sessions/{id} | 游标列表与公共状态 | 所有权；固定列表水位 |
| POST /v1/sessions/{id}/messages | 接收 text 或 typed command；产生 Message 和 Turn 意图 | key + canonical body hash；明确输入版本 |
| GET /v1/sessions/{id}/messages | 按公共顺序查询历史 | 有界 limit、游标和保留期 |
| POST /v1/sessions/{id}/switches | 申请更改 Harness/模型偏好 | expected epoch/version；重复同 key 返回同意图 |
| GET /v1/sessions/{id}/switches/{switchId} | 查看请求、准备、阻塞、生效或失败 | 请求与生效分开 |
| POST /v1/sessions/{id}/close | 停止新 admission，收敛当前执行和绑定 | 幂等，历史保留 |
| GET /v1/turns/{id} | 接收、排队、路由、执行与结算状态 | 不把不存在的 Attempt 伪造为运行中 |
| POST /v1/turns/{id}/cancel | 持久记录取消意图 | 202 表示受理；终态与清理另查 |
| GET /v1/sessions/{id}/events | SSE 重放/追踪公共事实 | Last-Event-ID/afterSeq，稳定事件身份 |
| POST /v1/permissions/{id}/decision | 提交实际 optionId | Attempt/epoch、未过期、有效选项、冲突决定拒绝 |
| GET /v1/artifacts/{id} | 下载登记成果 | 所有权、大小/hash 核验，不接受任意路径 |
| GET /v1/harnesses | 用户可见能力摘要；默认自动选择可隐藏具体列表 | 只读，标注证据等级 |
| POST/PUT /v1/admin/harnesses/{id} | 可信管理员注册或发布新 revision | 完整校验、expected revision |
| POST /v1/admin/harnesses/{id}/drain | 停止新 admission 并排空 | 当前执行不被无声杀掉 |
| DELETE /v1/admin/harnesses/{id} | 创建移除标记，受引用和排空规则限制 | 不删历史 revision |
| POST/GET /v1/admin/providers | 登记上游引用、协议与可用模型 | 秘密值经单独安全写入，不进入普通配置 |

接口最终路径、schema 和 operationId 由专属契约任务冻结；实现与 SDK 由同一契约生成或等价检查。不得把这张表当作已经存在的 API。

完整操作目录与 OpenAPI 的唯一所有者为 C009；Session 入口 G050、执行/权限入口 G051、Harness 管理 G061、Provider 管理 G062 分别实现各自路由，组合根 G059 集成。不能只完成前两类入口就声称注册/排空/移除已经可通过公共入口使用。

## 身份、幂等与并发

Idempotency-Key 是本项目自定义接口约定，不假称其已经是最终 IETF 标准。scope 为 principal + 操作类别 + Session（创建 Session 使用 principal 级）；同 key 与规范化等价 body 返回相同意图，异 body 为 IDEMPOTENCY_CONFLICT。等价规则、保存期限与清理明确记录；失去幂等记录时不得假装仍能去重。

命令接收事务保存确定的 Message/Turn/Switch ID、receivedAt、deadline、输入 hash、用户偏好以及 outbox。路由后 ExecutionPlan 另行固定实际 Harness revision、Provider/模型、context 与策略；偏好不等于已生效选择。

Session/配置变更使用 expectedVersion 或条件请求；缺少必须前置条件时 428，版本冲突 409/412 由契约任务统一。取消、deadline 和切换不通过普通新消息绕过控制仲裁。

## 输入、命令与错误

普通文本与网关 typed command 分开。CLI 的命令解析到相同应用命令；未知命令明确拒绝，不偷偷变成模型提示。允许的原生命令由 Adapter 显式声明，不能靠“以斜线开头”放行。

公共错误采用 RFC 9457 的 type/title/status/detail/instance，并扩展 code、requestId、可重试类别和字段错误；原生 cause 仅留脱敏诊断。领域错误码至少覆盖：UNSUPPORTED_CAPABILITY、NO_ELIGIBLE_HARNESS、MODEL_UNSUPPORTED、CONTEXT_TOO_LARGE、SESSION_BUSY、STALE_EPOCH、PERMISSION_EXPIRED、SWITCH_BLOCKED、RESOURCE_CLEANUP_UNCONFIRMED、STORAGE_UNAVAILABLE、EXECUTION_INTERRUPTED。

重试建议不能等同于自动重跑。SDK 可以重连只读事件流；有副作用的提交只在相同幂等身份下重送，未知执行不以新 key 自动再跑。
