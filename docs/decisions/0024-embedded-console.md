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
3. 在 07 规定的三道 CSRF 防线（SameSite=Strict、Origin 校验、改变状态的请求必须是 JSON 且不响应预检）之外，再加一道显式的 CSRF 值：每个会话有 256 位随机 CSRF 值，换取会话时返回；GET 与 HEAD 之外的 Cookie 请求必须以 `X-HH-CSRF` 携带，否则 403 `CSRF_TOKEN_INVALID`。为让刷新后的页面取回该值，新增 `GET /api/v1/auth/console-sessions/current`（06 第 5 节表格未列出）。`/api/v1` 上 `Sec-Fetch-Site` 存在时必须是 `same-origin`（07 第 5.3 节第 3 条）：同一主机其他端口的页面属于 same-site，SameSite Cookie 会随请求发出，这一条与 Origin 校验一起拒绝它们。
4. 旧 `/v1/*` 管理路由（任务、统一模型、工具、引擎、观测）保持原有规则：回环 Host、同源 Origin、拒绝 `cross-site`，不要求会话。它们在 0.x 内迁到 `/api/v1`（06 第 1 节），届时自然受会话保护；在此之前给它们单独加会话校验，需要同时改动 CLI、示例与测试中所有无凭据调用，而控制台本身同源访问这些路由不会扩大现有暴露面。
5. 移除 `--console-url`、`startHub({consoleUrl})` 与 `GET /v1/runtime/info` 的 `consoleUrl` 字段。

## 考虑过的替代方案

- **Jupyter 式查询参数 `?token=`、5 分钟有效**：所有者的初始提议，前提是设计未作规定；07 第 5.2 节已规定 URL 片段与 60 秒，片段不会进入服务器与访问日志，因此按 07 实现。命令沿用 06 的 `hh console`，不另设 `hh open`。
- **只依赖 07 的三道 CSRF 防线**：足以防御跨站请求，但同一主机其他端口的页面与 Cookie 同属一个站点，显式 CSRF 值让防护不依赖浏览器对 `Sec-Fetch-Site` 与 Origin 的实现细节；代价是一个只读接口与 SDK 的一个选项。
- **守护进程把 `packages/console/dist` 复制进自己的 `dist`**：不需要新的依赖边，但 `pnpm build` 会清空守护进程的 `dist`，构建顺序一旦颠倒控制台就缺失；新的 daemon → console 依赖只导出目录位置，与 10 第 1 节“构建产物作为静态资源嵌入 daemon”一致。
- **每次请求从磁盘解析路径**：需要自己处理路径穿越与符号链接；启动时索引后只提供索引中的普通文件，请求无法指向索引之外的任何文件。代价是重新构建控制台后要重启守护进程。

## 后果

- 一个端口、一个进程提供 API、模型网关与控制台；浏览器不再接触管理令牌，也不再需要 `HARNESSHUB_DATA_DIR`。
- Cookie 按主机名而不按端口区分：同一主机上任何本地 HTTP 服务都能收到 `hh_console` Cookie。能在本机监听端口并诱导浏览器访问的进程可以窃取会话；同一用户的进程本来就能读取 `admin.token`，风险主要在多用户机器上。`__Host-` 前缀要求 `Secure`，回环 HTTP 上不可用。
- 还没有 `hh admin-token rotate`；实现时必须同时吊销全部控制台会话（07 第 5.2 节）。
- 控制台的错误页、登录页与页面路径受守护进程的回退规则约束：页面路径不能以保留前缀或模型网关路径开头。
- 浏览器回归测试（10 第 3.6 节）尚未接入；本次以集成测试与一次真实浏览器走查为证据。

## 验证要求

- 集成测试（`tests/integration/console.test.ts`）：页面、资源与回退的状态码、缓存头与安全头；API、旧路由、健康检查与模型网关路径逐一不被回退遮蔽；未构建时 503；登录码只能用一次、Cookie 属性、缺少或错误的 CSRF 值 403、外源与 `same-site` 403、退出后 401、再次登录吊销旧会话、`hh console` 的输出与退出码。单元测试（`packages/daemon/test/console-session.test.ts`）覆盖 60 秒、12 小时与 7 天的边界和数量上限。
- `tools/check-console-contracts.test.mjs` 证明控制台的每个页面路径都在回退范围内；`tools/check-sea-build.test.mjs` 证明缺少构建时单文件构建失败。
- 从 `hh serve` 启动真实守护进程，在浏览器中打开打印的链接并走完每个页面，没有 CSP 违例或脚本错误。
