# ADR 0024：控制台内嵌守护进程与控制台会话

Status: proposed

日期：2026-10-04
关联决定：[ADR-P10 控制台改为内嵌静态单页](../proposals/oss/adr-drafts.md#adr-p10-控制台改为内嵌静态单页)；[07 第 5.2、5.3 节](../proposals/oss/07-data-security.md#52-本机管理令牌与控制台会话)；替代 [ADR 0013](0013-unified-model-gateway.md) 中 `--console-url` 跳转的做法

## 问题

Next.js 控制台是单独的 Node 进程（127.0.0.1:3330），经服务端代理 `app/api/gateway/[...path]` 访问守护进程，并由代理从 `HARNESSHUB_DATA_DIR/admin.token` 读取管理令牌加到 `/api/v1` 请求上。这需要两个进程、两个端口和一个能读令牌文件的服务端，与单文件分发（ADR-P01）冲突；守护进程根路径只能用 `--console-url` 跳转到另一个地址。所有者要求先把控制台做强：打开守护进程端口上的一个地址就得到完整界面。

## 决定

1. 控制台改为 React + Vite 静态单页，构建到 `packages/console/dist`。守护进程经 `@harnesshub/console/assets` 找到该目录（依赖图新增 daemon → console，只导入目录位置），启动时索引其中的普通文件，只提供索引中的文件：
   - `GET /` 与 `Accept` 含 `text/html` 的未匹配 GET/HEAD 返回 `index.html`（`Cache-Control: no-cache`）；`/api`、`/v1`、`/v1beta`、`/v1alpha`、`/health`、`/healthz`、`/readyz`、`/metrics`、`/assets`、`/openapi.json` 与模型网关路径从不回退，其余未匹配请求保留 Fastify 原有的 404 体。
   - `/assets/*` 是带内容哈希的文件，`Cache-Control: public, max-age=31536000, immutable`；其他顶层文件 `no-cache`。
   - 页面响应带 CSP（`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; … frame-ancestors 'none'`）、`nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY` 与同源的 COOP/CORP。样式允许内联：Radix 对话框插入滚动锁定的 `<style>`，代码高亮使用 style 属性；脚本不允许内联，主题脚本是单独文件。
   - 没有构建产物时页面返回 503 并说明 `pnpm build:console`，API 照常工作。单文件可执行程序嵌入整个 `dist`，构建时缺少则失败。
2. 控制台会话按 07 第 5.2 节实现（`console-session.ts`）：`hh console` 以管理令牌调用 `POST /api/v1/auth/console-links` 取得 128 位、60 秒、一次性的登录码，打印 `/#login=<code>`；`hh serve` 启动时在 stderr 打印同样的链接（不写日志文件）。页面以 `POST /api/v1/auth/console-sessions` 换取 `hh_console` Cookie（256 位，`HttpOnly; SameSite=Strict; Path=/`，经 TLS 时加 `Secure`），创建 7 天或空闲 12 小时后失效，`DELETE /api/v1/auth/console-sessions/current` 退出。登录码与会话只在内存中以 SHA-256 保存（最多 32 个登录码、64 个会话），守护进程重启即全部失效。
3. 在 07 规定的三道 CSRF 防线（SameSite=Strict、Origin 校验、改变状态的请求必须是 JSON 且不响应预检）之外，再加一道显式的 CSRF 值：每个会话有 256 位随机 CSRF 值，换取会话时返回；GET 与 HEAD 之外的 Cookie 请求必须以 `X-HH-CSRF` 携带，否则 403 `CSRF_TOKEN_INVALID`。为让刷新后的页面取回该值，新增 `GET /api/v1/auth/console-sessions/current`（06 第 5 节表格未列出）。（2026-10-05 起由下文“补充”取代：这个值成为标签页令牌，只在换取时返回，所有方法都要求，`current` 不再返回它。）`/api/v1` 上 `Sec-Fetch-Site` 存在时必须是 `same-origin`（07 第 5.3 节第 3 条）：同一主机其他端口的页面属于 same-site，SameSite Cookie 会随请求发出，这一条与 Origin 校验一起拒绝它们。
4. 旧 `/v1/*` 管理路由（任务、统一模型、工具、引擎、观测）保持原有规则：回环 Host、同源 Origin、拒绝 `cross-site`，不要求会话。它们在 0.x 内迁到 `/api/v1`（06 第 1 节），届时自然受会话保护；在此之前给它们单独加会话校验，需要同时改动 CLI、示例与测试中所有无凭据调用，而控制台本身同源访问这些路由不会扩大现有暴露面。
5. 移除 `--console-url`、`startHub({consoleUrl})` 与 `GET /v1/runtime/info` 的 `consoleUrl` 字段。

## 考虑过的替代方案

- **Jupyter 式查询参数 `?token=`、5 分钟有效**：所有者的初始提议，前提是设计未作规定；07 第 5.2 节已规定 URL 片段与 60 秒，片段不会进入服务器与访问日志，因此按 07 实现。命令沿用 06 的 `hh console`，不另设 `hh open`。
- **只依赖 07 的三道 CSRF 防线**：足以防御跨站请求，但同一主机其他端口的页面与 Cookie 同属一个站点，显式 CSRF 值让防护不依赖浏览器对 `Sec-Fetch-Site` 与 Origin 的实现细节；代价是一个只读接口与 SDK 的一个选项。
- **守护进程把 `packages/console/dist` 复制进自己的 `dist`**：不需要新的依赖边，但 `pnpm build` 会清空守护进程的 `dist`，构建顺序一旦颠倒控制台就缺失；新的 daemon → console 依赖只导出目录位置，与 10 第 1 节“构建产物作为静态资源嵌入 daemon”一致。
- **每次请求从磁盘解析路径**：需要自己处理路径穿越与符号链接；启动时索引后只提供索引中的普通文件，请求无法指向索引之外的任何文件。代价是重新构建控制台后要重启守护进程。

## 后果

- 一个端口、一个进程提供 API、模型网关与控制台；浏览器不再接触管理令牌，也不再需要 `HARNESSHUB_DATA_DIR`。
- Cookie 按主机名而不按端口区分：同一主机上任何本地 HTTP 服务都能收到 `hh_console` Cookie。原先的设计中，这个 Cookie 单独就能经 `GET /api/v1/auth/console-sessions/current` 取回 CSRF 值并完整使用 `/api/v1`；见下文“补充”，Cookie 现在单独无效。`__Host-` 前缀要求 `Secure`，回环 HTTP 上不可用。
- 还没有 `hh admin-token rotate`；实现时必须同时吊销全部控制台会话（07 第 5.2 节）。
- 控制台的错误页、登录页与页面路径受守护进程的回退规则约束：页面路径不能以保留前缀或模型网关路径开头。
- 浏览器回归测试（10 第 3.6 节）尚未接入；本次以集成测试与一次真实浏览器走查为证据。

## 验证要求

- 集成测试（`tests/integration/console.test.ts`）：页面、资源与回退的状态码、缓存头与安全头；API、旧路由、健康检查与模型网关路径逐一不被回退遮蔽；未构建时 503；登录码只能用一次、Cookie 属性、外源与 `same-site` 403、`hh console` 的输出与退出码；会话的两部分与多个标签页见下文“补充”。单元测试（`packages/daemon/test/console-session.test.ts`）覆盖 60 秒、12 小时与 7 天的边界和数量上限。
- `tools/check-console-contracts.test.mjs` 证明控制台的每个页面路径都在回退范围内；`tools/check-sea-build.test.mjs` 证明缺少构建时单文件构建失败。
- 从 `hh serve` 启动真实守护进程，在浏览器中打开打印的链接并走完每个页面，没有 CSP 违例或脚本错误。

## 补充：会话分为浏览器 Cookie 与标签页令牌（2026-10-05，安全审查 M3）

**问题。** 浏览器按主机而不按端口发送 Cookie（RFC 6265），`hh_console` 因此也会发给 `127.0.0.1` 上其他端口的服务。审查复现（未提交的脚本，现由下文的回归测试取代）：在浏览器中登录控制台后打开另一个本地端口的网页，该服务收到 Cookie，在浏览器之外（没有 Origin 与 `Sec-Fetch-Site`）用它请求 `GET /api/v1/auth/console-sessions/current` 得到 CSRF 值，随后以 Cookie 加 CSRF 值读写全部 `/api/v1`（例如关闭出站脱敏）。`Sec-Fetch-Site` 与 Origin 校验只约束浏览器，SameSite=Strict 不区分端口，第 3 条的 CSRF 值又能用 Cookie 单独取回，所以 Cookie 单独就是完整凭据。

**决定。** 会话由两部分组成，`/api/v1` 的每个请求（GET 与 HEAD 也一样）都必须同时带上：

- 浏览器的 `hh_console` Cookie，属性不变（`HttpOnly; SameSite=Strict; Path=/`，经 TLS 时加 `Secure`）。它现在是浏览器密钥：同一浏览器的多个会话共用它；换取会话时请求已带格式正确的 Cookie 就沿用，否则新建。
- 标签页的会话令牌（256 位），只由 `POST /api/v1/auth/console-sessions` 在换取时返回一次（字段仍叫 `csrfToken`，请求头仍是 `X-HH-CSRF`，SDK 选项不变）。控制台把它存在 `sessionStorage`：按源（含端口）隔离，只属于这个标签页，刷新后仍在；`sessionStorage` 不可用时只保存在页面内存中。

守护进程按令牌找到会话，再核对会话绑定的 Cookie；只有 Cookie、只有令牌或两者不属于同一会话一律 401 `CONSOLE_SESSION_INVALID`（不再有 403 `CSRF_TOKEN_INVALID`）。`GET …/current` 也需要两部分，且只返回 `expiresAt` 与 `idleExpiresAt`，不再返回令牌。令牌与 Cookie 值都只以 SHA-256 保存；期限、数量上限与“只在内存中”不变；CSP 不变。

**多个标签页。** 每个标签页用自己的一次性链接登录（`hh console`），各有自己的令牌；新的登录不再结束同一浏览器其他标签页的会话（原先“再次登录吊销旧会话”的行为取消）。刷新标签页保持登录；在新标签页中直接打开控制台（包括从控制台中用新标签页打开链接）时显示登录说明。浏览器的“复制标签页”会连同 `sessionStorage` 一起复制，两个标签页因此共用一个会话，退出其中一个后另一个显示会话已结束。退出只结束本标签页的会话；没有其他会话使用这个 Cookie 时同时清除它。守护进程拒绝某个令牌时不清除 Cookie，因为它可能属于其他标签页。Cookie 同样不按端口隔离写入：其他端口的服务可以改写或预先放置 `hh_console`，后果是各标签页需要重新登录，或换取会话时沿用一个它已知的 Cookie 值；两者都不给它令牌，因此不给它访问权。

**考虑过的替代方案。**

- **令牌只放在 `sessionStorage`、完全不用 Cookie**：同样解决端口问题，每个标签页独立；但令牌成为唯一凭据，页面中的脚本一旦被注入，就能把它带出浏览器长期使用。保留 HttpOnly 的 Cookie 后，带出的令牌还需要 Cookie，SameSite 与 Origin 规则也继续起作用。这层保护有限：本机另一个端口的服务本来就能收到 Cookie，同时拥有这样的服务和注入脚本能力的攻击者可以凑齐两部分，对此依靠 CSP（不允许内联脚本）防止注入。
- **保持一个会话一个 Cookie，只把 CSRF 值改为仅在登录时返回、所有方法都要求**：Cookie 单独同样无效，但 Cookie 只能指向一个会话，第二个标签页登录会替换 Cookie，使第一个标签页失效。
- **按端口或标签页给 Cookie 命名**：Cookie 仍会发给所有端口，只是多了名字管理，不解决问题。

**验证。** 单元测试：令牌必须与创建它的 Cookie 配对，另一个浏览器的 Cookie、格式不符或缺少的令牌都无效，同一浏览器的第二个会话沿用 Cookie 且不影响第一个，退出一个会话后 `bound` 判断 Cookie 是否仍被使用。集成测试：每种请求缺少任一部分或令牌不符都是 401 且不清除 Cookie，`current` 不返回令牌，两个标签页同时可用、退出一个不影响另一个、最后一个退出时清除 Cookie，另一个浏览器的 Cookie 与令牌不能混用；新增的回归测试按 RFC 6265 的 Cookie 规则让另一个回环端口的服务收到 Cookie，再在浏览器之外对 OpenAPI 文档中的每个 `/api/v1` 操作重放（只带 Cookie，或 Cookie 加猜测的令牌），全部 401（登录换取接口因缺少登录码为 400），而持有令牌的标签页仍然可用；该测试在原实现上失败（`GET /api/v1/system/info` 得到 200）。浏览器（无头 Chromium，本次构建）：登录后地址栏不含登录码、页面读不到 Cookie、令牌在 `sessionStorage`；刷新保持登录；没有链接的新标签页显示登录说明，用自己的链接登录后两个标签页同时可用；另一个端口的网页收到 `hh_console` 但读不到控制台的 `sessionStorage`，把 Cookie 在浏览器之外重放（只带 Cookie、加随机令牌、把 Cookie 值当令牌）对读、写、退出与签发链接都是 401 且不清除 Cookie；令牌被篡改的标签页显示会话已结束且不影响其他标签页；退出一个标签页后另一个仍可用、Cookie 保留，退出最后一个后 Cookie 清除，之后可以重新登录。
