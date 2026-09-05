# 动态引擎管理

Gateway 可以从空引擎目录启动，运行时发现和登记引擎，无需重启服务。发现结果代表安装文件存在；真正的模型、工具和恢复能力须按实际 Run 判断。发现格式见 [本机发现](engine-discovery.md)，非 ACP 命令见 [CLI Driver](cli-driver.md)。

## 最短操作路径

以下命令在已构建并运行的本机 Gateway 上执行，示例使用默认端口 3180；本次 Mac 演示端口为 3182。需要系统安装 `curl` 和 `jq`。

```sh
curl -s http://127.0.0.1:3180/v1/engines/discover
curl -s http://127.0.0.1:3180/v1/engines/discover \
  | jq '.candidates[] | select(.id == "dsh") | .registration' \
  | curl -s -X POST http://127.0.0.1:3180/v1/engines \
      -H 'Content-Type: application/json' --data-binary @-
curl -s -X POST http://127.0.0.1:3180/v1/sessions \
  -H 'Content-Type: application/json' -d '{"engineId":"dsh"}'
```

用返回的 Session ID 调用原有 `POST /v1/sessions/:id/runs` 分配任务。切换引擎就是为下一项任务创建不同 `engineId` 的 Session；同一 Session 的后续 Run 固定原版本。任意新引擎可直接 POST 一份注册配置，或增加 manifest 后重新请求发现；不需要修改 Gateway 源码。

## 管理接口

| 接口 | 行为 |
|---|---|
| `GET /v1/engines` | 当前登记的引擎、revision、启用状态与能力 |
| `GET /v1/engines/discover` | 每次重新扫描 PATH、已知安装目录和本地 manifests |
| `POST /v1/engines` | 完整新增或替换一个引擎，提交后返回 201 |
| `PUT /v1/engines/:id` | 完整新增或替换；body.id 必须等于路径 id |
| `DELETE /v1/engines/:id` | 从当前目录移除；历史 revision 和旧会话保留 |
| `PUT /v1/engines/default` | body 为 `{"engineId":"dsh"}`，设置新会话默认引擎 |
| `POST /v1/engines/reload` | 手动重新读取配置文件，全体校验通过后应用 |
| `GET /v1/engines/registry` | 默认引擎、文件监视状态、最后成功 reload 时间和错误码 |

注册字段为 `id`、`driver`、`command`，以及可选的 `enabled`、`model`、`credentialEnv`、`maxConcurrency`、`cli`、`acp`、`configuration`。独立模型/Provider、密钥引用、Skills、MCP 及校验见 [引擎配置](engine-configuration.md)。全部字段由 [公共 schema](../src/domain/schemas.ts)约束并进入生成的 OpenAPI。未知字段包括嵌套拼写错误直接失败，不会被删除后偷偷使用默认值。禁用使用完整注册配置并设置 `enabled:false`。`fake/default/discover/registry/reload` 是保留 ID。

## 配置更新与持久化

文件中的 YAML/JSON 引擎配置作为基础目录，API 登记是持久 overlay，同 ID 时 API 配置优先。DELETE 保存移除标记，因此文件 reload 或服务重启不会让已移除引擎重新出现；再次 POST/PUT 可以重新启用。文件更新只改变未被 API 覆盖的条目。要替换 API 管理的条目，继续使用 PUT，不靠修改其基础文件副本。

每次写入先在 Gateway 所有的 SQLite 提交 `runtime_metadata.engine_catalog` 的 version 2 数据（兼容读取并升级 version 1），再发布内存目录；包含 overlay、默认选择和完整历史执行 revision。Session/Run 继续只保存安全配置快照与命令 hash。既有数据库在首次新版启动时增加该 metadata key，不修改已有记录或 `user_version`；未知 catalog 版本或内容 hash 不匹配明确拒绝启动。

启动时显式 `AGENT_ENGINE` 在合并持久目录后校验，并保存为新的默认选择；之后 API 可以更新它。没有显式启动选择时，先用已保存默认，再用配置默认；均未选择时取首个启用引擎。已选择的默认引擎被移除或禁用后，无 `engineId` 的新 Session 返回 `ENGINE_UNAVAILABLE`，需要显式选定可用引擎，避免自动改派。

使用 `--config` 时每 500 ms 检查文件变化，支持编辑器的原子替换保存。完整解析和校验成功才应用；失败保留最后有效配置，错误码可从 registry 状态查询。Workspace、并发总额、Worker 数、期限默认等部署设置仍在启动时固定；修改这些字段的 reload 返回 `CONFIG_RESTART_REQUIRED`，该次引擎修改也不部分生效。仅更新引擎及其默认选择可热加载。

在活进程内更新、禁用或移除引擎不会迁移旧 Session，活动及排队 Run 继续解析原 `engineId + profileRevision`。旧 revision 中的命令、模型选择及限制保持不变。恢复仍按 Driver 自身契约：未显式启用恢复的 ACP Profile 在重启时关闭 Session；启用后的条件和 DSH 实证见 [严格恢复](session-recovery.md)；CLI 每轮无上下文，历史命令 revision 可继续使用。这不等于跨引擎迁移或 ACP 上下文恢复。

## 本机调用边界

服务只绑定 loopback，并校验 loopback Host，拒绝跨 Origin 与跨站浏览器请求。本版本面向单用户本机调用，不提供远程多用户鉴权。登记配置可以启动本机程序，应由本机用户管理。

命令是固定 argv，不隐式经过 shell。凭证仅写 `credentialEnv` 变量名或配置文件路径引用，不应出现在 command、manifest 或任务正文。解析器拒绝常见密钥/令牌环境赋值及敏感命令参数，但无法判断任意脚本代码中的所有字符串；不要嵌入明文秘密。发现不会复制认证、执行 `--version`、调用模型或联网安装 Adapter。

引擎目录最多 1000 个当前引擎、10000 个历史 revision；满时明确失败，不自动删掉旧 Session 所需版本。关闭 Gateway 会先停监视并等待在途管理操作完成，再回收执行资源。
