# HarnessHub Console

控制台是 React 19 + Vite 8 构建的静态单页（[ADR-P10](../../docs/proposals/oss/adr-drafts.md#adr-p10-控制台改为内嵌静态单页)、[ADR 0024](../../docs/decisions/0024-embedded-console.md)），由守护进程在自己的端口提供：打开一个地址就是完整的界面，不再有单独的控制台进程或服务端代理。界面使用 Tailwind CSS 4.3.3、shadcn/ui、assistant-ui 0.15.18、AI Elements、Streamdown 2.6.0 和 Lucide。执行状态来自守护进程；前端的 assistant-ui ExternalStoreRuntime 仅负责消息呈现与 Composer 交互，不引入第二套 Agent Runtime。

## 运行

在项目根目录使用 Node 24.20.0 / pnpm 10.12.3：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
pnpm exec hh serve --data-dir ./data/local
```

`pnpm build:console`（`tools/console.mjs build`）以白名单环境运行 `vite build`，产物写入 `packages/console/dist`：`index.html`、`theme-boot.js`、`icon.svg` 与带内容哈希的 `assets/`；构建后在 `dist` 中搜索随机金丝雀与凭据形态环境变量的值，命中即失败（OSS-014）。守护进程经 `@harnesshub/console/assets` 找到这个目录，启动时建立文件索引；重新构建后需要重启守护进程。单文件可执行程序把 `dist` 作为资源嵌入（`tools/sea/build.mjs`），构建前必须先 `pnpm build:console`。

`hh serve` 启动后在 stderr 打印一次性登录链接 `http://127.0.0.1:3180/#login=<code>`，60 秒内可用一次；之后需要登录时运行 `pnpm exec hh console --data-dir ./data/local`（守护进程用了其他端口时加 `--url`）。登录流程见 [07 第 5.2 节](../../docs/proposals/oss/07-data-security.md#52-本机管理令牌与控制台会话)：

- 登录码在 URL 片段中，不会发给服务器或进入访问日志；页面读取后立即用 `history.replaceState` 清除，再以 `POST /api/v1/auth/console-sessions` 换取 `hh_console` Cookie（`HttpOnly; SameSite=Strict; Path=/`，创建 7 天或空闲 12 小时后失效）与会话的 CSRF 值（[lib/session.ts](lib/session.ts)）。
- 刷新页面时用 `GET /api/v1/auth/console-sessions/current` 取回 CSRF 值；`/api/v1` 的请求经 `@harnesshub/sdk` 发出，GET 之外的请求带 `X-HH-CSRF`。在另一个标签页重新登录会替换 Cookie，原页面遇到 403 `CSRF_TOKEN_INVALID` 时读取新会话的 CSRF 值并重发一次（守护进程在执行前就拒绝了该请求）。
- 会话结束（401）时页面切换到登录提示；左下角的按钮退出登录。没有会话时页面只提示运行 `hh console`，不提供口令表单。会话只在守护进程内存中，重启后需要重新登录。
- 旧 `/v1/*` 管理接口（任务、统一模型、工具、引擎、观测）保持原来的规则：只校验回环 Host 与同源 Origin，不需要会话；它们迁到 `/api/v1` 后改由会话保护（[ADR 0024](../../docs/decisions/0024-embedded-console.md)）。

每个页面有自己的地址（`/`、`/model`、`/providers`、`/groups`、`/keys`、`/usage`、`/agents`、`/tools`、`/engines`、`/observability`，见 [lib/router.ts](lib/router.ts)），可以刷新、收藏和前进后退；任务页的 `?session=` 与 `?workflow=` 指向当前任务。守护进程只对 `Accept` 含 `text/html` 的 GET 回退到 `index.html`，`/api`、`/v1`、`/v1beta`、`/v1alpha`、`/health`、`/assets`、`/openapi.json` 与模型网关的路径（`/models`、`/responses`、`/messages`、`/chat/completions`）从不回退，所以页面路径不能使用它们（`tools/check-console-contracts.test.mjs` 检查）。页面响应带 `Content-Security-Policy`（只允许本源脚本，不允许内联脚本与嵌入框架）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 与同源的 COOP/CORP；主题脚本因此是单独的 `/theme-boot.js`。

开发时用 Vite 开发服务器（热更新），它在 127.0.0.1:3330 提供页面，并把 `/api`、`/v1`、`/v1beta`、`/v1alpha`、`/health` 与 `/openapi.json` 转发给 `HARNESSHUB_DAEMON_URL`（默认 `http://127.0.0.1:3180`），保留原 Host，使守护进程的 Host 与 Origin 校验看到页面自己的地址：

```sh
pnpm start:local --dev            # 守护进程 3180 + 开发服务器 3330，打印开发服务器的登录链接
# 或者对已在运行的守护进程：
HARNESSHUB_DAEMON_URL=http://127.0.0.1:3180 pnpm dev:console
pnpm exec hh console --url http://127.0.0.1:3330 --data-dir ./data/local
```

Cookie 按主机名而不按端口区分，所以在 3180 或 3330 登录的会话两边都能用。`pnpm check:console` 依次运行控制台的 lint、`tsc --noEmit` 与构建。

`--demo` 登记的 fake 引擎只用于测试，不出现在任务页的引擎选择器中；用 HTTP 在 fake 上创建的会话（见 [HTTP 接口自测](../../docs/getting-started.md#http-接口自测开发用)）会出现在历史中，可以在页面中查看和继续对话。真实引擎的自有配置按 [配置说明](../../docs/engine-management.md)准备。macOS 的 Keychain helper 需要 Xcode Command Line Tools；通用前置条件见 [快速开始](../../README.md#quick-start-from-source)。守护进程只绑定 loopback。

## 页面与状态

- 状态条：每 5 秒探测 `/health/ready`，显示 Full Access 与统一模型（来自 `/v1/runtime/info`、`/v1/harness/model`）。接口不存在（Fastify 路由 404）时显示“当前 Gateway 不支持”，业务 404 仍按错误显示。
- 任务工作台：默认直接执行，另有自动规划。会话与历史每 3 秒同步（页面可见时）；继续对话时即使会话不在最近 200 条内也沿用原会话。工具调用显示为可读卡片，原始 JSON 折叠；还有流式正文、思考展开和实际权限请求。
- 自动计划：先展示步骤、依赖、产物与选择依据，确认后执行；失败或取消不偷偷重试。
- 执行详情：模型、阶段耗时、token、费用来源、安装版本、覆盖缺口、产物下载和轨迹导出；`model.call` 记录列表及“已记录的调用发往哪个上游模型”的汇总，只依据已提交事件，不推断未经网关的调用。
- 统一模型：编辑 `HarnessModel` 并 `PUT /v1/harness/model`；API Key 与敏感请求头先经 `POST /v1/secrets` 写入系统安全存储，只提交引用；“测试连接”调用 `POST /v1/harness/model/test`，在所选引擎上跑一个真实短任务并可跳到该 Run。字段规则见 [统一模型](../../docs/engine-configuration.md#统一模型)。
- 工具与插件：`GET /v1/tool-packs` 列出安装包，绑定关系由各引擎当前配置中的包内容 digest 推导；导入、应用到全部/所选引擎和解除绑定分别调用 `POST /v1/tool-packs/import`、`POST /v1/tool-packs/apply`（`engineIds`）和 `DELETE /v1/tool-packs/{id}/{version}/bindings`，展示逐引擎结果与 warnings。
- 引擎管理：进入页面主动发现，可见期间每分钟及重新可见时刷新；注册、启停、默认选择和热加载。识别清单与各引擎接入方式见 [本机发现](../../docs/engine-discovery.md)，安装证据不等于模型可用。每行支持 [独立配置与检查](../../docs/engine-configuration.md)，可编辑模型、Provider、Keychain/环境/文件密钥引用、Skills 和 MCP；配置统一模型后模型与 Provider 只读并原样保存。
- 运行观测：真实状态计数、负载、p50/p95、已知 token 与样本覆盖、按 Run 追溯。
- 模型平面（[`/api/v1`](../../docs/model-plane-api.md)，经 `@harnesshub/sdk` 的 `HarnessHubClient` 以控制台会话访问 `/api/v1/*`）：
  - Provider：列表、从预设添加（选择预设后端点已填好，可修改；填写 API Key 一并保存）、手动添加与编辑（端点按官方 SDK 基址约定，守护进程返回的 `errors[]` 显示在对应字段下）、删除（被路由组或 Key 引用时显示 409 的引用方）；每个 provider 的凭据可添加（密码框，值只发送一次）、轮换与删除，只显示引用；模型列表显示上下文、最大输出、价格（输入 / 输出，美元每百万 token）与是否对外列出，悬停在值上显示其来源与时间（覆盖、手工填写、上游列表、预设或 models.dev 快照，未知时不估计），可从上游刷新（失败时保留原列表并标为未更新）。
  - 路由组：增删改，成员从各 provider 的模型中选择。
  - Gateway Key：创建 `client:` Key（名称、允许的模型、有效期），Key 文本只显示一次并可复制；列表与吊销。
  - 用量：按模型、provider 或 UTC 日期汇总所选时间范围，未定价的调用单独标出、不计为 0；最近调用按游标分页，显示状态、模型、provider、token、费用与耗时。
  - Agent：本机支持的 Agent 的安装状态、接线的模型（显示其中几个网关模型）、Key 状态与漂移标记；接线或修改时选择模型与 Agent 选择器中显示的模型，先预览配置文件的 diff（Key 已掩码；长路径与长行在对话框内滚动），确认后写入；换 Key 与还原需要确认（见 [全局接线](../../docs/global-wiring.md)）。

  统一模型、工具、引擎、观测与任务页面仍使用 `lib/api.ts` 与 `/v1/*` 旧接口。

当前任务 ID 保存在 URL 中，刷新从持久数据恢复。SSE 使用真实命名事件与序号，40ms 合并显示更新；流结束（Gateway 已提交终态）时立即刷新该会话，网络断开时以事件游标和持久查询追赶；较早发出的刷新结果不会覆盖较新的视图。关闭页面不取消任务，停止按钮才发出取消请求。没有生成静态伪任务、伪曲线或用零代替未知用量。

界面使用浅色主题、清晰焦点、中文标签和克制过渡，尊重 `prefers-reduced-motion`，窄屏改用导航菜单与抽屉。控制台是本机应用，尚未加入远端多用户认证、完整账单对账或全平台桌面发行。

## 组件来源与许可

`components/ui` 基于 [shadcn/ui 官方 registry](https://ui.shadcn.com/)，保留 [MIT 许可](licenses/shadcn-ui.txt)。`components/ai-elements` 来自 [Vercel AI Elements](https://github.com/vercel/ai-elements)，用于 Reasoning、Sources、Tool、Artifact、Plan 与代码块；保留 [原始许可声明](licenses/ai-elements.txt)和 [Apache 2.0 完整条款](licenses/apache-2.0.txt)。已修改本地 import、类型边界、异步事件处理和中文呈现，文件头明确标注适配。

Thread、Message、Composer 与前端状态适配使用 [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)；Markdown 使用 [Streamdown](https://streamdown.ai/)。包版本由根目录 pnpm workspace 锁统一管理。组件生成源码随 Git 固定，不在运行时拉取 registry。
