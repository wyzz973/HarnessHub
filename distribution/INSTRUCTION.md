# HarnessHub 比赛执行说明（INSTRUCTION）

适用环境：**Windows 10/11 x64，离线**。本说明面向评测执行方，按顺序执行即可，全程不需要联网、不需要安装 Node.js、pnpm、Python 或 Git，也不需要管理员权限。

## 1. 交付结构

```text
solution/
  INSTRUCTION.md              本说明
  code/                       完整源码 + 离线依赖 + 固定版本引擎（下文记为 <CODE>）
    HarnessHub/               源码（含依赖声明 package.json / pnpm-lock.yaml 与配置）
    tools/node/  tools/pnpm-runner/   Node 24.20.0 x64 与 pnpm 10.12.3
    pnpm-store/               离线 pnpm 依赖仓库
    prepared/win32-x64/       固定版本引擎运行文件
    Setup-Competition-Offline.cmd     离线准备：恢复依赖、编译、生成比赛运行布局
    Start-Competition.cmd     启动比赛服务（唯一启动入口）
    INSTRUCTION.md            本说明的副本
```

`<CODE>` 就是 `solution\code`。建议解压到较短路径（例如 `D:\hh\solution`），避免 Windows 路径过长；磁盘建议预留 20 GB。

## 2. 环境准备与依赖安装（离线，执行一次）

在 PowerShell 中执行：

```powershell
cd <CODE>
.\Setup-Competition-Offline.cmd
```

该命令依次完成：检查运行环境与离线包完整性 → 仅在 `node_modules` 缺失时从 `pnpm-store` 离线恢复依赖 → 编译 Gateway 与控制台 → 用本地固定引擎打包出 `<CODE>\competition\` 运行布局 → 不调用模型的启动自检（真实启动一次比赛服务并调用健康检查、建会话、删除会话后关闭）。通常需要 5–15 分钟。

- **成功判定**：退出码为 0（`$LASTEXITCODE` 为 0），最后输出 `[HarnessHub] Competition layout ready: ...\competition` 和一行 `{"event":"competition.setup.completed",...,"selftest":"PASS","downloads":false,"modelCalled":false}`。
- **离线保证**：准备过程中 npm/pnpm 被强制为离线模式，registry 与代理指向不可达地址；任何下载尝试都会直接报错，不会静默联网。
- 日志：`<CODE>\logs\setup-competition-*.log`。可重复执行；已有的 `competition\` 会被改名为 `competition.previous-<时间>` 保留。`.\Setup-Competition-Offline.cmd --reinstall` 会强制从 `pnpm-store` 重新恢复依赖。

## 3. 模型配置（只用环境变量）

所有引擎只使用这里配置的同一个模型，由 HarnessHub 统一转发；引擎自带的 API Key、登录或订阅都不会被使用（每个引擎使用 `competition\state` 下的私有目录）。上游须为**流式** OpenAI Chat Completions 接口。

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `HARNESSHUB_MODEL` | 是 | 上游真实模型 ID；设置后统一模型才生效 |
| `HARNESSHUB_MODEL_BASE_URL` | 是 | 接口基地址，通常以 `/v1` 结尾，不含 `/chat/completions` |
| `HARNESSHUB_MODEL_API_KEY` | 视上游而定 | 密钥本身；只在进程环境中使用，不写入任何文件 |
| `HARNESSHUB_MODEL_PROTOCOL` | 否 | 默认 `openai-completions` |
| `HARNESSHUB_MODEL_CONTEXT_WINDOW` | 否 | 上下文窗口，正整数 |
| `HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS` | 否 | 单次输出上限，正整数 |

```powershell
$env:HARNESSHUB_MODEL = "<模型ID>"
$env:HARNESSHUB_MODEL_BASE_URL = "http://<模型网关地址>/v1"
$env:HARNESSHUB_MODEL_API_KEY = "<密钥>"
```

只设置可选变量而不设置 `HARNESSHUB_MODEL`，或设置了 `HARNESSHUB_MODEL` 却缺少 `HARNESSHUB_MODEL_BASE_URL`，服务会拒绝启动并说明原因。必须在**启动服务的同一个窗口**中设置。

## 4. 选择引擎：`AGENT_ENGINE`

引擎只通过环境变量 `AGENT_ENGINE` 切换，可选值：`opencode`、`codex`、`hermes`、`qwen`、`pi`、`gemini`、`mimo`、`dsh`、`openclaw`、`kimi`。

```powershell
$env:AGENT_ENGINE = "opencode"    # 主引擎
$env:AGENT_ENGINE = "hermes"      # 第二个引擎示例（也可用 "codex"）
```

cmd.exe 写法为 `set AGENT_ENGINE=opencode`。切换引擎：在服务窗口按 Ctrl+C 停止，修改 `AGENT_ENGINE` 后重新启动。服务启动后，每个 `POST /session` 固定使用启动时的引擎。

## 5. 启动服务（唯一启动命令）

```powershell
cd <CODE>
.\Start-Competition.cmd
```

- 比赛 API 默认监听 `http://localhost:6217`（`http://127.0.0.1:6217` 同样可用），默认只接受本机访问。可选参数原样透传：`--port 6217`、`--host localhost`。
- 评测客户端在另一台机器或容器中时，改用 `.\Start-Competition.cmd --host 0.0.0.0`（或指定网卡地址），再用本机 IP 访问 6217 端口。这种绑定**没有鉴权**，同一网络中的任何人都能驱动已开启 Full Access 的引擎，只能在隔离的评测网络中使用；Windows 防火墙可能需要放行 `<CODE>\competition\runtime\node.exe` 的入站连接或 6217 端口。
- 同时会启动 Web 控制台（默认 `http://127.0.0.1:3330`，端口被占用时自动换成空闲端口），浏览器打开 `http://localhost:6217/` 会跳转到控制台。评测只需要 6217 端口的比赛 API，控制台不影响也不会阻塞 Gateway；不需要时加 `--no-console`，`--console-port <端口>` 指定端口，`--open` 就绪后自动打开浏览器。
- **进程需保持运行**：不要关闭该窗口；评测结束后按 Ctrl+C 停止。
- 未设置 `AGENT_ENGINE` 时命令以退出码 2 结束，并列出可用引擎；尚未执行第 2 节时会提示先运行 `Setup-Competition-Offline.cmd`。
- 默认开启 Full Access：引擎的工具与权限请求自动批准（见第 9 节）。

## 6. Ready 判定

满足以下两条即表示服务就绪：

1. 服务窗口输出一行 JSON：`{"event":"competition.ready","url":"...","engine":"opencode","port":6217,...,"consoleUrl":"http://127.0.0.1:3330"}`。
2. `GET http://127.0.0.1:6217/health/ready` 返回 200 与 `{"ready":true}`（就绪前连接失败或返回 503）。

另一个窗口中等待就绪的示例：

```powershell
for ($i = 0; $i -lt 180; $i++) {
  try { if ((Invoke-RestMethod http://127.0.0.1:6217/health/ready).ready) { "ready"; break } } catch { }
  Start-Sleep -Seconds 1
}
```

可选核对：`GET /v1/runtime/info` 返回 `{"competition":true,"competitionEngine":"opencode","fullAccess":true,"consoleUrl":"http://127.0.0.1:3330"}`；`GET /v1/harness/model` 中 `configured` 为 `true`、`source` 为 `"environment"`。

## 7. 调用方式（Agent 网关规范 v1.1）

基地址 `http://127.0.0.1:6217`，请求与响应均为 UTF-8 JSON。默认只接受本机访问；评测客户端在其他机器或容器中时按第 5 节以 `--host 0.0.0.0` 启动，并把基地址换成本机 IP。

1. **创建会话** `POST /session`

   ```json
   {"title": "office_002", "directory": "D:\\eval\\office_002"}
   ```

   返回 200：

   ```json
   {"id": "3f9c6c8e-5a51-4f35-9d0f-6d1f2b1c7a10", "title": "office_002", "created_at": "2026-09-20T01:02:03.000Z", "status": "idle", "directory": "D:\\eval\\office_002"}
   ```

   `directory` 必填，不存在时自动递归创建；建议使用绝对路径（相对路径按服务进程当前目录 `<CODE>\competition` 解析）。

2. **（可选）订阅事件** `GET /event`（SSE），每帧为 `data: {"type":...,"properties":{...}}`，连接后先收到 `server.connected`。

3. **提交任务** `POST /session/{id}/prompt_async`

   ```json
   {"parts": [{"type": "text", "text": "请自动打开 Outlook 邮件客户端"}], "model": {"providerID": "provider_xxx", "modelID": "gpt-4"}, "agent": "assistant"}
   ```

   该请求**阻塞到本轮结束**：成功或被中止返回 204（无响应体）；失败返回 502 `{"code":"BAD_GATEWAY","message":"<真实原因>"}`。`model` 可填任意值（只校验格式），实际一律使用第 3 节的统一模型。客户端超时要足够长（建议 ≥ 3600 秒）。

4. **读取结果** `GET /session/{id}/message`，返回消息数组，最后一条为 assistant：

   ```json
   [
     {"id": "R:user", "role": "user", "content": "请自动打开 Outlook 邮件客户端"},
     {"id": "R:assistant:1", "role": "assistant", "content": "我先查看工作目录。",
      "tool_calls": [{"id": "call_1", "name": "bash", "arguments": {"command": "ls"}}],
      "info": {"role": "assistant", "finish": "tool-calls"},
      "parts": [{"type": "text", "content": "我先查看工作目录。"}, {"type": "tool", "callID": "call_1", "tool": "bash", "state": {"status": "completed", "title": "List workspace files"}}, {"type": "step-finish"}]},
     {"id": "R:tool:call_1", "role": "tool", "tool_call_id": "call_1", "tool_name": "bash", "content": "README.md\n"},
     {"id": "R:assistant:2", "role": "assistant", "content": "已打开 Outlook。", "tool_calls": [],
      "info": {"role": "assistant", "finish": "stop"},
      "parts": [{"type": "text", "content": "已打开 Outlook。"}, {"type": "step-finish"}]}
   ]
   ```

5. **中止** `POST /session/{id}/abort`（或 `/stop`）返回 `{"ok":true}`，阻塞中的 `prompt_async` 随后返回 204。

6. **结束会话** `DELETE /session/{id}` 返回 `{"ok":true}`（重复调用同样返回）；会话关闭后历史仍可查询，但不能再提交。

其他接口：`GET /session/{id}`（含 `message_count`）、`GET /session/status`（`{"<id>":{"type":"busy"|"idle"}}`）、`GET /question`、`GET /permission`、`POST /permission/{id}/reply`（`{"reply":"once"|"always"|"reject"}`）。错误响应统一为 `{"code","message"}`：400 `VALIDATION_ERROR`、404 `NOT_FOUND`、502 `BAD_GATEWAY`、503 `SERVICE_UNAVAILABLE`、500 `INTERNAL_ERROR`。

PowerShell 最小调用链（Windows PowerShell 5.1 与 7 均可）：

```powershell
$base = "http://127.0.0.1:6217"
$type = "application/json; charset=utf-8"
$create = @{ title = "office_002"; directory = "D:\eval\office_002" } | ConvertTo-Json
$session = Invoke-RestMethod -Method Post -Uri "$base/session" -ContentType $type -Body ([Text.Encoding]::UTF8.GetBytes($create))
$prompt = @{ parts = @(@{ type = "text"; text = "请自动打开 Outlook 邮件客户端" }); model = @{ providerID = "provider_xxx"; modelID = "gpt-4" }; agent = "assistant" } | ConvertTo-Json -Depth 5
(Invoke-WebRequest -UseBasicParsing -TimeoutSec 3600 -Method Post -Uri "$base/session/$($session.id)/prompt_async" -ContentType $type -Body ([Text.Encoding]::UTF8.GetBytes($prompt))).StatusCode
(Invoke-RestMethod -Uri "$base/session/$($session.id)/message")[-1].info
Invoke-RestMethod -Method Delete -Uri "$base/session/$($session.id)"
```

`Invoke-WebRequest`/`Invoke-RestMethod` 遇到 400/404/502 会抛出异常，响应体仍为 `{code,message}`。

## 8. 评测数据映射与完成判定

评测数据如 `{"task_id":"office_002","query":"请自动打开 Outlook 邮件客户端",...}`：

| 评测字段 | 对应请求 |
|---|---|
| `task_id`（或标题） | `POST /session` 的 `title` |
| 该任务的工作目录 | `POST /session` 的 `directory` |
| `query` | `prompt_async` 的 `parts[0].text`（原文） |

**执行完成判定（规范 8.4）**：一轮在以下任一情况出现时结束：`prompt_async` 返回；SSE 出现 `session.status` 为 `idle`、`session.idle` 或 `session.error`。之后 `GET /session/{id}/message` 的最后一条消息总是 `assistant` 且 `parts` 含 `step-finish`，其 `info.finish`：

| Run 结果 | `info.finish` | 说明 |
|---|---|---|
| 正常完成 | `stop` | `prompt_async` 返回 204 |
| 失败、超时、中断 | `error` | `info.error` 为 `{code,message}`；`prompt_async` 返回 502，SSE 先发 `session.error` |
| 被中止 | `cancelled` | `prompt_async` 返回 204 |

`stop` 只表示执行正常结束，任务是否达标由评测方判断。因模型上游错误（`MODEL_UPSTREAM_ERROR`）或引擎没有输出（`ENGINE_NO_OUTPUT`）失败的一轮会保留会话，可在同一会话中重试；ACP 引擎的其他失败、超时或被中止会关闭该会话（再提交返回 400 `VALIDATION_ERROR`），此时需新建会话。建议每个任务使用新会话。

## 9. 权限与反问

- 比赛入口默认开启 Full Access（`HARNESSHUB_FULL_ACCESS=1`）：引擎切换到各自的完全访问模式，工具与权限请求自动批准；`prompt_async` 等待期间也会自动批准待决权限，无需人工参与。
- 引擎不会经 HarnessHub 反问：`GET /question` 恒为 `[]`。
- 如评测方需要显式决定权限：`GET /permission` 列出待决请求，`POST /permission/{id}/reply` 提交 `once`、`always` 或 `reject`。

## 10. 结果交付件

| 内容 | 位置 |
|---|---|
| 任务产出文件 | 创建会话时的 `directory` |
| 对话与工具轨迹 | `GET /session/{id}/message` |
| 会话的 Run 列表 | `GET /v1/sessions/{id}/runs` |
| 单个 Run 的状态、错误与输出 | `GET /v1/runs/{runId}` |
| 完整事件导出（JSONL） | `GET /v1/runs/{runId}/rollout` |
| 事件日志（含每次模型调用 `model.call`） | `GET /v1/runs/{runId}/event-log` |
| 模型、用量与耗时观测 | `GET /v1/runs/{runId}/observations` |
| 持久记录 | `<CODE>\competition\state\competition-data\`（`harnesshub.sqlite` 与 `artifacts\`） |
| 准备与自检日志 | `<CODE>\logs\` |

`state` 目录只保存密钥的环境变量名，不保存密钥本身。需要干净的评测状态时，停止服务后删除 `<CODE>\competition\state`，或重新执行第 2 节。

## 11. 常见问题

- **端口 6217 被占用**：`netstat -ano | findstr :6217` 查找占用进程，或改用 `.\Start-Competition.cmd --port 6218` 并相应修改评测地址。控制台端口被占用会自动换端口，不影响比赛 API。
- **从其他机器调用返回 403 或连接失败**：默认绑定只接受本机访问，按第 5 节改用 `--host 0.0.0.0` 启动，并检查 Windows 防火墙是否放行 6217 端口。
- **`AGENT_ENGINE is not set`**：按第 4 节设置后重新启动。**`Engine X is not included in this bundle`**：`AGENT_ENGINE` 取值不在第 4 节列表中。
- **启动时报统一模型变量错误**：按第 3 节补齐 `HARNESSHUB_MODEL` 与 `HARNESSHUB_MODEL_BASE_URL`，正整数变量不要带单位。
- **`prompt_async` 返回 502，原因含上游错误**：检查模型地址、密钥与网络连通性；`POST /v1/harness/model/test`（请求体 `{}`）会向模型发一条极短的流式请求用于诊断。
- **`Setup-Competition-Offline.cmd` 失败**：查看 `<CODE>\logs\` 中最新日志。常见原因：磁盘空间不足；杀毒软件隔离了引擎程序（提示 `Prepared engine files are missing`，需恢复文件或加白名单）；路径过长（改用短路径重新解压）。依赖损坏时可加 `--reinstall` 重试。
- **文件被 Windows 标记为来自网络**：在 PowerShell 中执行 `Get-ChildItem -Recurse <CODE> | Unblock-File` 后重试。
- **需要确认只使用了统一模型**：`GET /v1/runs/{runId}/event-log` 中每条 `model.call` 事件的 `upstreamModel` 均为 `HARNESSHUB_MODEL` 的值。
