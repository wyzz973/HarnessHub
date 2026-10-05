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

- 登录码在 URL 片段中，不会发给服务器或进入访问日志；页面读取后立即用 `history.replaceState` 清除，再以 `POST /api/v1/auth/console-sessions` 换取会话（[lib/session.ts](lib/session.ts)）：浏览器的 `hh_console` Cookie（`HttpOnly; SameSite=Strict; Path=/`，创建 7 天或空闲 12 小时后失效）与这个标签页的会话令牌。令牌只在换取时返回一次，保存在 `sessionStorage`（按源与端口隔离、只属于这个标签页、刷新后仍在；不可用时只保存在页面内存中）。
- `/api/v1` 的每个请求经 `@harnesshub/sdk` 发出，带 Cookie 与 `X-HH-CSRF: <令牌>`，两者缺一不可：浏览器也会把 Cookie 发给本机其他端口的服务，但没有令牌它什么也打不开（[ADR 0024 补充](../../docs/decisions/0024-embedded-console.md#补充会话分为浏览器-cookie-与标签页令牌2026-10-05安全审查-m3)）。刷新页面时用 `GET /api/v1/auth/console-sessions/current` 确认保存的令牌仍然有效。
- 每个标签页分别登录：在新标签页中直接打开控制台时显示登录说明，用一个新的 `hh console` 链接登录；各标签页的会话互不影响。会话结束（401）时页面切换到登录提示；左下角的按钮只退出本标签页。没有会话时页面只提示运行 `hh console`，不提供口令表单。会话只在守护进程内存中，重启后需要重新登录。
- 旧 `/v1/*` 管理接口（任务、统一模型、工具、引擎、观测）保持原来的规则：只校验回环 Host 与同源 Origin，不需要会话；它们迁到 `/api/v1` 后改由会话保护（[ADR 0024](../../docs/decisions/0024-embedded-console.md)）。

每个页面有自己的地址（见 [lib/router.ts](lib/router.ts)），可以刷新、收藏和前进后退：首页 `/` 是 Agent，另有 `/profiles`、`/providers`、`/subscriptions`、`/routing`（`/routing/auto-groups`、`/routing/keys`、`/routing/credentials`、`/routing/decisions`）、`/usage`（`/usage/conversations`）、`/library`（`?tab=mcp|skills|sync`）、`/settings`（`/settings/features`、`/settings/backup`），任务相关的 `/tasks`、`/model`、`/engines`、`/tools` 与 `/observability`。`/?agent=<id>` 打开一个 Agent 的详情，任务页的 `?session=` 与 `?workflow=` 指向当前任务；早期版本的 `/agents`、`/groups`、`/keys` 与 `/?session=…` 自动改写到现在的地址。守护进程只对 `Accept` 含 `text/html` 的 GET 回退到 `index.html`，`/api`、`/v1`、`/v1beta`、`/v1alpha`、`/health`、`/assets`、`/openapi.json` 与模型网关的路径（`/models`、`/responses`、`/messages`、`/chat/completions`）从不回退，所以页面路径不能使用它们（`tools/check-console-contracts.test.mjs` 检查）。页面响应带 `Content-Security-Policy`（只允许本源脚本，不允许内联脚本与嵌入框架）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 与同源的 COOP/CORP；主题脚本因此是单独的 `/theme-boot.js`。

开发时用 Vite 开发服务器（热更新），它在 127.0.0.1:3330 提供页面，并把 `/api`、`/v1`、`/v1beta`、`/v1alpha`、`/health` 与 `/openapi.json` 转发给 `HARNESSHUB_DAEMON_URL`（默认 `http://127.0.0.1:3180`），保留原 Host，使守护进程的 Host 与 Origin 校验看到页面自己的地址：

```sh
pnpm start:local --dev            # 守护进程 3180 + 开发服务器 3330，打印开发服务器的登录链接
# 或者对已在运行的守护进程：
HARNESSHUB_DAEMON_URL=http://127.0.0.1:3180 pnpm dev:console
pnpm exec hh console --url http://127.0.0.1:3330 --data-dir ./data/local
```

Cookie 按主机名而不按端口区分，所以在 3180 或 3330 登录的会话两边都能用。`pnpm check:console` 依次运行控制台的 lint、`tsc --noEmit` 与构建。

`--demo` 登记的 fake 引擎只用于测试，不出现在任务页的引擎选择器中；用 HTTP 在 fake 上创建的会话（见 [HTTP 接口自测](../../docs/getting-started.md#http-接口自测开发用)）会出现在历史中，可以在页面中查看和继续对话。真实引擎的自有配置按 [配置说明](../../docs/engine-management.md)准备。macOS 的 Keychain helper 需要 Xcode Command Line Tools；通用前置条件见 [快速开始](../../README.md#install-from-source)。守护进程只绑定 loopback。

## 语言

界面有中文（`zh-CN`，源语言）与英文（`en`）两种（[lib/i18n.ts](lib/i18n.ts)）。语言在“设置 → 语言”中选择，保存在这个浏览器的 `localStorage`（`harnesshub.locale`，读写失败时只对当前页面生效）；没有选择时按浏览器的语言列表取第一个中文或英文，其他语言用英文。切换后整个界面重新渲染。日期、数字与金额按所选语言格式化（`formatDateTime`、`formatNumber`、`formatUsd`）。守护进程返回的问题详情、风险告知、体检结论、预设名称等内容按守护进程发送的原样显示；控制台自己组织的错误文字（按错误码）在目录中。

文字在 [lib/messages](lib/messages/) 中，每个区域一个模块（`common`、`agents`、`providers`、`subscriptions`、`library`、`backup`、`settings`、`routing`、`usage`、`tasks`），同一模块中写中文与英文两份：中文以 `as const` 声明，英文的类型要求同样的键，占位符写作 `{name}`，英文可用 `{n, plural, one {…} other {…}}` 区分单复数。组件用 `t(key, values)`；值需要是 React 节点（链接、代码）时用 `tr`（[lib/i18n-react.tsx](lib/i18n-react.tsx)）。`tools/check-console-i18n.test.mjs` 检查两种语言的键与占位符一致、键不跨区域、英文中没有中文，并在组件或库模块出现目录之外的中文字面量时失败（注释除外；语言切换中“中文”这个名称与按全角逗号分隔的输入解析是登记过的例外）。新增界面文字时把两种语言同时写入所属区域的模块。

## 页面与状态

侧栏分两组：网关（Agent、Provider、订阅账号、路由与 Key、用量、Profile、Library、设置）与任务（新建任务、统一模型、引擎、工具、观测，以及任务历史）。网关的页面以控制台会话经 `@harnesshub/sdk` 访问 [`/api/v1`](../../docs/model-plane-api.md)；任务的页面仍使用 `lib/api.ts` 与 `/v1/*` 旧接口。

- **Agent（首页，[agents-page.tsx](components/agents-page.tsx)）**：本机每个已安装、只有配置或已接线的 Agent 一行，显示它经网关使用的模型；点模型打开可搜索的选择器（按 provider 分组，显示上下文窗口与价格，其后是路由组与自动路由组），选定后先预览配置文件的 diff（Key 已掩码），确认后写入。行上标出漂移与“需要处理”（Key 失效、配置被改、找不到 Agent、所选模型已不在网关、管理员的托管设置覆盖了接线写入的项），页首汇总；被 Claude Code 的托管设置（`managed-settings.json`，只读取）覆盖时另有“被托管设置覆盖”标记，预览、结果与详情列出文件与被覆盖的项。Agent 的 `notice`（例如 Claude Code 与 Codex 需要重启会话才用上新的设置，按守护进程的原文显示）出现在预览（“应用之后”）、接线结果（这时对话框保持打开）、详情与还原、换 Key、隐藏模型的提示中。可以直接还原。未发现的 Agent 折叠在下面，也可以预先接线。
- **首次使用（[first-run.tsx](components/first-run.tsx)）**：还没有 provider 时首页显示浏览器中的 `hh init`：选预设（区域、套餐、端点与请求头）并填 Key → 从上游读取模型（失败时用预设的列表）→ 勾选本机已安装的 Agent → 选默认模型 → 所有 Agent 的改动合在一份预览中，确认后逐个接线并列出结果。已按相同选择接线、Key 有效且没有漂移的 Agent 不重新接线，与 `hh init` 相同；可以随时跳过，之后从页首的提示重新打开。
- **Agent 详情（`?agent=<id>`，[agent-detail.tsx](components/agent-detail.tsx)）**：主模型；Claude Code 的 Opus、Sonnet、Haiku、Fable 档与子 Agent 模型（缺省跟随主模型）；推理强度；Adapter 选项（Codex 的 `codexAuth`：Gateway Key 或 ChatGPT 登录；ChatGPT 登录同样签发 Key，模型可选，不选时用 Codex 自己的模型、不写 effort，切换到 ChatGPT 登录时不沿用原来的模型，见 [ADR 0030](../../docs/decisions/0030-codex-chatgpt-mode-models.md)；之前版本留下的没有 Key 的 ChatGPT 接线提示“签发 Key”）；首页的模型选择器对这种 Agent 另有“自己的模型”一项；“显示 N / M 个模型”，逐个隐藏或显示（`PUT /agents/{id}/models`，正在使用的模型不能隐藏，Key 不变）；Key、换 Key 与暂停、恢复 Key（暂停后标为需要处理）；配置文件与逐项漂移；还原。每次写入前都先预览改动。
- **Profile**：把所有已接线 Agent 的选择保存为 Profile（同名替换前提示）；应用前逐个 Agent 显示将切换的改动，确认后一次切换；删除前确认。
- **订阅账号（`/subscriptions`，[subscriptions-page.tsx](components/subscriptions-page.tsx)）**：ChatGPT 套餐与 GitHub Copilot 账号的列表（状态：可用、已退出登录、需要接受新的告知、已停用），重新登录、退出登录（说明厂商是否确认撤销）与删除。登录先显示该后端当前版本的风险告知，必须勾选接受才能继续。ChatGPT：页面在点击时打开新标签页并转到 API 返回的 OpenAI 授权地址，OpenAI 把浏览器送回守护进程的回环回调，页面每 1.5 秒查询这次登录直到完成或过期（显示剩余时间；新标签页被拦截时给出链接；“取消登录”或关闭对话框经 `DELETE /subscriptions/sign-in/{id}` 结束这次登录，浏览器的回调正在完成时不能取消，页面等待结果）。Copilot：显示 SDK 附加组件与 Copilot CLI 是否就绪，确认后由守护进程用 npm 安装 SDK；用 CLI 自己的登录或细粒度 PAT 登录。登录成功后读取该 provider 的模型列表（经 API 登录时守护进程不读取）。账号行显示网关的路由状态（休息中、待探测）与额度读数（如 Copilot 的高级请求：已用比例与续期时间）。
- **Provider**：列表与详情带厂商标志（订阅 provider 用 OpenAI 与 GitHub Copilot 的标志；其账号在“订阅账号”页管理，详情页不提供添加或轮换凭据）；列表中有凭据在休息的 provider 标出“休息中”，详情的凭据表有“路由状态”一列（正常、休息中及到期时间与倒计时、待探测，最近一次失败的类别、状态码与时间，额度读数），每 5 秒刷新；列表与详情页有启用开关（停用前确认：它的模型从 `/v1/models`、自动路由组与 Agent 的模型列表中消失，接线到它们的 Agent 标为需要处理，文件不改写；停用时详情页顶部说明并可直接启用）；凭据表每行有启用开关，关闭最后一个启用的凭据时守护进程以 409 `CREDENTIAL_LAST_ENABLED` 拒绝，页面说明原因并提供“改为停用 provider”；编辑时可填写图像端点（OpenAI 兼容 Images API 的基址）与代理（使用守护进程的代理、直连，或这个 provider 自己的代理地址，与 `hh provider proxy` 相同；地址不能含密码，守护进程拒绝的原因显示在该字段下；Copilot provider 没有这一项），详情页显示所选的代理；每个凭据的并发上限（同时发出 1–1024、排队 0–65536，与 `hh provider limits` 相同；占位符显示网关默认的 8 与 64，留空用网关的上限，清空已有的值以 null 删除；不是整数时在发送前提示，范围由守护进程检查），详情页列出设置了的上限；详情页的“检测”（[provider-doctor.tsx](components/provider-doctor.tsx)，订阅 provider 不可用）：“测试端点”对每个端点发一个最小请求，列出状态、耗时与实际模型；“体检”先显示计划（请求数与预计成本，可选超长输入与慢响应阈值），点击后才运行，逐项列出通过、警告、失败与跳过、观测、上游错误与建议命令，建议的修改确认后应用（见 [Provider 测试与体检](../../docs/provider-doctor.md)）；从预设添加时可搜索预设（按类型分组），选择区域与套餐后端点随之改变，填写厂商文档列出的请求头（必填的未填不能创建）；“导入”可以粘贴 `harnesshub://` 或 `magpie://` 链接，或读取本机 Claude Code、Codex 的配置，先预览每个 provider 的去向（主机、Key 末四位或环境变量、模型）再选择导入；手动添加与编辑、凭据的添加、轮换与删除、模型列表（窗口、输出、价格及其来源）与从上游刷新同前。
- **路由与 Key**：路由组（[groups-page.tsx](components/groups-page.tsx)）：策略（含 `smart` 与 `pace`）、粘性与有序的成员，每个模型成员可固定推理强度（`none` 到 `max`）、勾选 `fast`，也可加入另一个路由组，可上下移动；守护进程拒绝的成员（例如没有快速模式的模型）标在该行。“规则”（[rules-editor.tsx](components/rules-editor.tsx)）按 `hh group rule add` 的写法输入（`use=… tokens=200k images effort=high agents=… intent="…" compact time=… days=… classifier=… at=N`），用与守护进程相同的代码（`@harnesshub/sdk/route-rules`）即时读取，读不懂或不合规则时标出出错的词并给出原因；规则可修改、上下移动与删除，另选分类器与“推理强度：自动”，保存时守护进程的错误标在对应的规则上。自动路由组（两个以上 provider 同名的模型，`group/auto-<名字>`），可以隐藏与恢复；Gateway Key 的创建、列表、改名、暂停与恢复（暂停前确认，列表显示“已暂停”；暂停的 Key 得到 401 `key_suspended`，恢复后照常可用）与吊销，创建时可勾选“局域网”（与 `hh key create --lan` 相同，附明文 HTTP 的警告，这时不能选“永不过期”；列表中标出“局域网”），创建时与“额度”中可设置每分钟请求数与每天、每周、每月的 token 或成本预算（0 拒绝该窗口内的每次调用，可计入缓存读取；[key-budgets.tsx](components/key-budgets.tsx)），列表显示额度，“用量”打开每个预算本窗口的已用、在途预留、重置时间与是否用尽（`GET /api/v1/gateway-keys/{id}/limit`，打开时每 5 秒读取）；“路由决定”页签（[route-decisions.tsx](components/route-decisions.tsx)）列出路由组每一轮的决定：命中的规则与条件、分类器的判断（是否来自缓存或冷却）、选出的推理强度、粘性、候选的尝试顺序与应答者，可只看一个会话，“实时跟随”以长轮询读取新的决定（`GET /api/v1/routing/decisions?after=&wait=`，换会话或离开页面时中止）；“凭据状态”页签（[routing-state.tsx](components/routing-state.tsx)）列出每个凭据的熔断状态、休息到期时间与倒计时、最近一次失败与额度读数（`/api/v1/routing/state`，页面可见时每 5 秒读取，守护进程重启后熔断状态清空、读数保留）。
- **用量**：按模型、provider、凭据（`provider/凭据`）、Key、Agent 或 UTC 日期汇总所选时间范围，未定价的调用单独标出、不计为 0；最近调用显示 provider 与凭据，以及规范化的结束原因（正常结束、达到输出上限、工具调用、内容过滤，其他值按上游原样显示）；失败的调用显示错误类别（例如代理连接失败、无法连接上游、被限流，未知类别按守护进程原样显示），凭据的“最近一次失败”用同样的说法。“下载汇总 CSV”与“下载调用 CSV”按所选的时间范围（与汇总的分组）下载 CSV（`format=csv`，经 SDK 带会话令牌请求后存为文件；只带 Cookie 的链接会得到 401，[lib/usage-export.ts](lib/usage-export.ts)）；还没有关闭的用量提醒（`GET /api/v1/usage/alerts`，[lib/usage-alerts.ts](lib/usage-alerts.ts)，页面可见时每分钟读取）显示在页面顶部，导航中的“用量”带标记，“知道了”只在这个浏览器中隐藏已显示的提醒。“会话”页签按会话汇总调用（`/api/v1/conversations`）：Agent、模型、凭据、token 与费用，展开可看该会话的逐次调用。
- **Library（`/library`，[library-page.tsx](components/library-page.tsx)）**：指令集（Markdown 编辑与预览，去往的 Agent；Kimi 与 Hermes 没有用户级指令文件，已被其他指令集占用的 Agent 不能再选）；MCP 服务（本地命令或 HTTP、SSE；普通环境变量与请求头之外，秘密逐个以环境变量、文件或新值登记，已保存的秘密只显示“已保存”且原样保留；守护进程以 `SECRET_REF_FORBIDDEN` 拒绝引用 HarnessHub 自身凭据时显示规则并标出对应的行，把凭据当普通值时提示移到秘密）；Skills（上传浏览器中选择的文件夹或 zip：在浏览器中读取并解压，先按 500 个文件、20 MiB 检查并确认有 SKILL.md，单一顶层文件夹作为名称，忽略 `.DS_Store` 与 `.git`，zip 中的链接与加密条目被拒绝，可执行权限只来自 zip；或导入守护进程所在电脑上的目录路径；改变去往的 Agent，删除）；“同步到 Agent”选择 Agent、是否允许写入明文秘密与是否复制 Skill，先预览每个文件的 diff、Skill 的放置、被拒绝的条目与警告，确认后按这份预览写入（预览之后文件被改则该 Agent 什么都不写，提示重新预览）。
- **设置**：“通用”页签：语言（中文或英文，见上文“语言”）；局域网共享（开关、监听地址、端口、主机名、公开地址，明文 HTTP 的警告；开启前确认）；模型目录的状态与立即刷新；守护进程的出站代理（只读：代理地址，密码显示为 `***`，来源与不经代理的主机，来自 `GET /api/v1/system/info` 的 `network`）；版本、数据目录、秘密存储与网关基址。“网关功能”页签（`/settings/features`，[gateway-features-page.tsx](components/gateway-features-page.tsx)，见 [网关功能](../../docs/gateway-features.md)）每项各用一行说明费用与隐私（视觉兜底把图片发给视觉模型的 provider 并多一次计费调用；联网搜索把脱敏后的查询发给登记的搜索服务，由该服务计费，模型多答至多 6 轮）：出站脱敏的开关（关闭前确认）与自己的规则（正则表达式、忽略大小写，同名替换，守护进程拒绝的规则（例如会灾难性回溯的写法）的原因显示在正则表达式栏下）；视觉兜底的模型（可搜索的选择器，或不使用；说明描述以发出请求的 Key 进行：视觉模型须在它允许的模型中，计入它的预算与每分钟请求数，每个请求至多描述 `gateway.limits.maxDescribedImages` 张）；联网搜索后端（Tavily、Brave、Exa、Firecrawl、SearXNG，按登记顺序使用，Key 只发送一次；地址含用户名与密码等被拒绝的原因显示在对应的栏下）的添加与删除；用量提醒的阈值（1–100%，或关闭）；设置了图像端点的 provider。修改对下一个请求生效。“备份与同步”页签（`/settings/backup`，[backup-page.tsx](components/backup-page.tsx)）：口令输入两次后下载加密备份，可不含凭据的值；恢复先上传文件、输入口令并预览（新增、替换、需要填写 Key、缺少秘密、被拒绝的 Library 条目、网关功能：出站脱敏的开关、脱敏规则与搜索后端的变化、视觉模型及本机没有它时的原因，每个 Agent 的重新接线或“已相同”、需重新签发的 client Key），确认后恢复；备份中有从本机读取 Key 的凭据（`providers.references`）时，预览以警告列出凭据、读取的位置与 Key 将发往的主机，勾选确认后“恢复”才可用并带 `references: true`；永不恢复的凭据与搜索 Key（`providers.refused`、`search.refused`）连同原因列在“不会恢复”中；备份会关闭本机开着的出站脱敏时，预览与结果的顶部都有醒目的警告，没有 Key 而未带入的搜索后端附“打开联网搜索”（`/settings/features?section=search`，页面滚动到该卡片），可不重新接线或不带入 Library；带入了 Library 时接着预览并确认写入本机 Agent。同步：WebDAV 或 S3 的设置（密码与口令只发送一次，之后留空即保留已保存的），保存后立即同步一次；状态（上次与下次同步、最近的错误、两边都改时被替换的部分与副本位置、保留的 provider；服务器的网关功能关闭了本机的出站脱敏时的警告与“打开出站脱敏”，服务器的设置要关闭脱敏但本机设置同样新或更新、因而本机仍开启时的提示（`notice.redactionOffHeld`），同步没有带入的项（`notice.refused`），以及“立即同步”遇到较旧的服务器文件（409 `SYNC_ROLLBACK`）时的说明与“接受较旧的文件”（确认风险后发送 `acceptOlder: true`），服务器上没有 Key、本机也没有而未带入的搜索后端）、立即同步与关闭。口令与秘密只在表单中，页面不保存。
- 状态条（任务页面）：每 5 秒探测 `/health/ready`，显示 Full Access 与统一模型（来自 `/v1/runtime/info`、`/v1/harness/model`）。接口不存在（Fastify 路由 404）时显示“当前 Gateway 不支持”，业务 404 仍按错误显示。
- 任务工作台（`/tasks`）：默认直接执行，另有自动规划。会话与历史每 3 秒同步（页面可见时）；继续对话时即使会话不在最近 200 条内也沿用原会话。工具调用显示为可读卡片，原始 JSON 折叠；还有流式正文、思考展开和实际权限请求。
- 自动计划：先展示步骤、依赖、产物与选择依据，确认后执行；失败或取消不偷偷重试。
- 执行详情：模型、阶段耗时、token、费用来源、安装版本、覆盖缺口、产物下载和轨迹导出；`model.call` 记录列表及“已记录的调用发往哪个上游模型”的汇总，只依据已提交事件，不推断未经网关的调用。
- 统一模型：编辑 `HarnessModel` 并 `PUT /v1/harness/model`；API Key 与敏感请求头先经 `POST /v1/secrets` 写入系统安全存储，只提交引用；“测试连接”调用 `POST /v1/harness/model/test`，在所选引擎上跑一个真实短任务并可跳到该 Run。字段规则见 [统一模型](../../docs/engine-configuration.md#统一模型)。
- 工具与插件：`GET /v1/tool-packs` 列出安装包，绑定关系由各引擎当前配置中的包内容 digest 推导；导入、应用到全部/所选引擎和解除绑定分别调用 `POST /v1/tool-packs/import`、`POST /v1/tool-packs/apply`（`engineIds`）和 `DELETE /v1/tool-packs/{id}/{version}/bindings`，展示逐引擎结果与 warnings。
- 引擎管理：进入页面主动发现，可见期间每分钟及重新可见时刷新；注册、启停、默认选择和热加载。识别清单与各引擎接入方式见 [本机发现](../../docs/engine-discovery.md)，安装证据不等于模型可用。每行支持 [独立配置与检查](../../docs/engine-configuration.md)，可编辑模型、Provider、Keychain/环境/文件密钥引用、Skills 和 MCP；配置统一模型后模型与 Provider 只读并原样保存。
- 运行观测：真实状态计数、负载、p50/p95、已知 token 与样本覆盖、按 Run 追溯。

写入操作的约定：改写 Agent 配置的操作（接线、切换模型、改档位、应用 Profile、首次使用的接线、Library 同步）先显示 diff 再确认；恢复先预览摘要再确认；还原、换 Key、删除与吊销、开启局域网共享、关闭出站脱敏、删除搜索后端、关闭同步、退出订阅账号、安装 Copilot SDK 先确认，与 `hh` 命令询问 `[y/N]` 的操作一致。失败的操作在对话框内显示守护进程的说明，或在右下角以通知显示，通知的“技术详情”含错误码与请求 ID；成功的操作也以通知确认。列表为空时统一显示说明与下一步。

当前任务 ID 保存在 URL 中，刷新从持久数据恢复。SSE 使用真实命名事件与序号，40ms 合并显示更新；流结束（Gateway 已提交终态）时立即刷新该会话，网络断开时以事件游标和持久查询追赶；较早发出的刷新结果不会覆盖较新的视图。关闭页面不取消任务，停止按钮才发出取消请求。没有生成静态伪任务、伪曲线或用零代替未知用量。

界面使用浅色主题、清晰焦点、中英文标签和克制过渡，尊重 `prefers-reduced-motion`，窄屏改用导航菜单与抽屉。控制台是本机应用，尚未加入远端多用户认证、完整账单对账或全平台桌面发行。

## 组件来源与许可

厂商与 Agent 的标志来自 [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons)（MIT），按预设的 `icon`（lobehub slug）在构建时打包进控制台（[lib/brand-icons.ts](lib/brand-icons.ts)），页面不从其他来源加载；没有对应文件的显示名称首字母。标志归各自的所有者。

`components/ui` 基于 [shadcn/ui 官方 registry](https://ui.shadcn.com/)，保留 [MIT 许可](licenses/shadcn-ui.txt)。`components/ai-elements` 来自 [Vercel AI Elements](https://github.com/vercel/ai-elements)，用于 Reasoning、Sources、Tool、Artifact、Plan 与代码块；保留 [原始许可声明](licenses/ai-elements.txt)和 [Apache 2.0 完整条款](licenses/apache-2.0.txt)。已修改本地 import、类型边界、异步事件处理和中文呈现，文件头明确标注适配。

Thread、Message、Composer 与前端状态适配使用 [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)；Markdown 使用 [Streamdown](https://streamdown.ai/)。包版本由根目录 pnpm workspace 锁统一管理。组件生成源码随 Git 固定，不在运行时拉取 registry。
