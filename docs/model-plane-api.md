# 模型平面 API 与 CLI

守护进程在 `/api/v1` 下提供模型平面的管理接口：provider 与凭据、路由组、`client:` Gateway Key、`model.call` 账本与用量（设计见 [06 接口与交互面](proposals/oss/06-interfaces.md) 与 [03 模型平面](proposals/oss/03-model-plane.md)）。[`@harnesshub/sdk`](../packages/sdk/README.md) 是它的类型化客户端，`hh provider|credential|key|group|usage|status` 经 SDK 调用它。现有的 `/v1/*` 管理路由暂时保持原样，之后再迁到 `/api/v1`；模型网关的挂载与全局接线路由在网关与接线库落地后加入。逐接口的输入、返回与错误见 [API 实现参考](api/reference.md)（`/api/v1` 各节）。

## 认证与错误

- 守护进程启动时在数据目录中创建 `admin.token`（256 位随机数的 base64url，0600；已存在则校验后沿用），内存中只保留其 SHA-256。`/api/v1` 的每个请求都必须带 `Authorization: Bearer <令牌>`，而且来自回环连接；服务器原有的 Host、Origin 与 `Sec-Fetch-Site` 校验照常执行在前。令牌文件可被其他用户读取、是链接或内容无效时启动失败（`ADMIN_TOKEN_INSECURE`），删除后重启会生成新令牌。令牌不经命令行参数或环境变量传递。
- 改变状态的请求（POST、PUT、PATCH）必须是 `application/json`（PATCH 也接受 `application/merge-patch+json`），否则 415。请求中的未知字段返回 400。
- 错误一律是 RFC 9457 `application/problem+json`：`type`、`title`、`status`、`detail`、`instance`、`code`、`requestId`，输入错误另有 `errors[]`（`pointer` 指向请求体成员，或 `parameter` 指向查询参数），被引用而不能删除时另有 `references[]`。
- 金额是十进制字符串 `{amount, currency: "USD"}`；时间是 RFC 3339。

尚未实现：ETag 与 `If-Match`、`Idempotency-Key`、控制台会话，以及配置列表的分页（provider、凭据、路由组与 Key 的列表一次返回全部，`nextCursor` 为 `null`）。

## 资源

| 资源 | 操作 | 要点 |
|---|---|---|
| providers | `GET`、`POST /providers`；`GET`、`PATCH`、`DELETE /providers/{id}` | 端点是厂商官方 SDK 的基址：chat 与 responses 含 `/v1`，anthropic 与 gemini 不含版本段；以操作路径或版本段结尾、内嵌凭据、带查询串或片段、公网 HTTP 的基址被拒绝，`errors[]` 指向 `/endpoints/<协议>`。`PATCH` 是 JSON Merge Patch。被路由组或未吊销的 Key 引用时删除返回 409 |
| credentials | `GET`、`POST /providers/{id}/credentials`；`PUT .../{credentialId}/secret`；`DELETE .../{credentialId}` | `value` 存入秘密后端，响应只含 `{kind:"store", value:<UUID>}` 引用；也可以给 `env` 或 `file` 引用。轮换保持引用不变；删除凭据或 provider 时同时删除托管秘密。06 第 3 节的 `/credentials` 顶层资源改为挂在 provider 下 |
| route-groups | `GET`、`POST /route-groups`；`GET`、`PATCH`、`DELETE /route-groups/{id}` | 成员必须是已存在 provider 的 Model Ref；被未吊销的 Key 允许时删除返回 409 |
| gateway-keys | `GET`、`POST /gateway-keys`；`GET /gateway-keys/{id}`；`POST /gateway-keys/{id}/revoke` | 只签发 `client:` 作用域，`modelAllow` 必填；默认 90 天后过期，`expiresAt: null` 不过期。Key 文本只出现在创建响应中，列表与详情不含哈希 |
| model-calls | `GET /model-calls` | 新到旧，`limit` 1–200（默认 50），`cursor` 为上一页的 `nextCursor`；按 `from`（含）、`to`（不含）、`keyId`、`provider`、`model`、`sessionId` 过滤 |
| usage | `GET /usage` | `groupBy` 为 `day`（UTC）、`provider`、`model`（默认）、`key` 或 `adapter`；状态码不低于 400 记为失败，成本只累加已知价格，未知价格计入 `unpricedCalls`，`missing` 用量按 0 计 |
| system | `GET /system/info` | 版本、提交、pid、启动时间、数据目录与秘密后端 |

秘密后端由 `hh serve --secrets-backend auto|keychain|dpapi|file` 选择（默认 `auto`：macOS 钥匙串、Windows DPAPI、其他平台加密文件），加密文件后端的主密钥在 `--config-dir`（默认为平台的 HarnessHub 配置目录）下的 `secrets.key`，见 [secrets](../packages/secrets/README.md)。

## CLI

命令经 `--url`（默认 `http://127.0.0.1:3180`）连接守护进程，从 `--data-dir`（默认 `./data`，与 `hh serve` 相同）读取 `admin.token`。默认输出表格，`--json` 输出与 API 响应相同的 JSON；失败时 `--json` 把 problem 对象写到 stdout，并在 stderr 写一行说明。

```sh
hh status
hh provider add deepseek --chat https://api.deepseek.com/v1 \
  --anthropic https://api.deepseek.com/anthropic --model deepseek-chat
hh credential add deepseek --name main          # 在终端中隐藏输入
printf '%s' "$KEY" | hh credential add deepseek --from-stdin
hh credential rotate deepseek key-1 --from-env NEW_KEY
hh group add fast --member deepseek/deepseek-chat --strategy latency
hh key create --name ci --allow deepseek/* --allow group/fast   # Key 只打印这一次
hh usage --by provider --since 7d
hh key revoke <keyId> --yes
```

- 秘密从不作为参数：终端中隐藏输入，非交互时必须用 `--from-stdin`、`--from-env <变量>` 或 `--from-file <路径>`，否则以 2 退出。
- `provider remove`、`credential remove`、`group remove` 与 `key revoke` 需要确认；`--yes` 跳过，非交互且没有 `--yes` 时以 4 退出且不做修改。stdin 不是终端、设置了 `CI` 或给出 `--non-interactive` 时为非交互。
- 退出码（06 第 5 节）：0 成功；1 内部错误；2 用法错误、输入无效或名称不存在；3 守护进程不可达或数据目录中没有令牌；4 需要确认；5 冲突（409、412、422）；6 认证失败；7 达到上限或未就绪（429、503）；130 中断。

控制台的 Provider、路由组、Gateway Key 与用量页面经同源代理调用这些接口；代理在服务端从 `HARNESSHUB_DATA_DIR/admin.token` 读取令牌，浏览器拿不到它（见 [控制台](../packages/console/README.md)）。

测试：[api-v1.test.ts](../tests/integration/api-v1.test.ts) 在进程内启动守护进程，经 SDK 验证认证、校验、凭据值不出现在任何响应、日志与数据目录文件中、Key 的签发与吊销、基于写入账本的用量；[hh-cli.test.ts](../tests/integration/hh-cli.test.ts) 对同一守护进程运行真实的 `hh` 入口。
