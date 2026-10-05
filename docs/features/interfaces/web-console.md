# Web 控制台

| 项 | 内容 |
|---|---|
| 分类 | 界面与入口 |
| 状态 | 已实现 |
| 验证 | 集成测试（页面、资源、回退路径、安全头、登录与会话、跨站拒绝）、单元测试（会话期限与上限）、工具组（页面路由契约、中英文目录、路由辅助函数、构建环境）与 `pnpm check:console`（lint、类型检查、构建），在 macOS arm64 本机通过；浏览器只有人工走查，没有自动回归；Windows 未验证 |
| 对照 Magpie | 部分：Browser version 一行为有意不同（没有远程控制台），Pages 一行为部分（没有 Agent 自己会话文件的页面），English and Chinese 一行相同，Desktop app 与 Menu-bar 两行未覆盖（[Terminal UI and console](../../magpie-parity.md#terminal-ui-and-console)） |
| 权威文档 | [控制台](../../../packages/console/README.md)、[ADR 0024](../../decisions/0024-embedded-console.md)、[ADR 0034](../../decisions/0034-console-languages.md)、[07 第 5.2 节](../../proposals/oss/07-data-security.md#52-本机管理令牌与控制台会话) |

## 用途

在浏览器中管理本机的模型平面与 Agent：接线、provider、订阅账号、路由组与 Key、用量、Profile、Library 与设置，以及无人值守的任务。守护进程在自己的端口直接提供页面，打开 `hh console` 打印的一次性链接即登录，浏览器从不接触管理令牌。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | `http://127.0.0.1:3180/`，侧栏分“网关”（Agent、Provider、订阅账号、路由与 Key、用量、Profile、Library、设置）与“任务”（新建任务、引擎、工具、观测、任务历史；有旧来源时另有已弃用的“统一模型”） |
| 命令行 | `hh serve` 启动时在 stderr 打印登录链接；`hh console [--url URL] [--data-dir DIR] [--json]` 生成新链接 |
| HTTP | `POST /api/v1/auth/console-sessions`、`GET`/`DELETE /api/v1/auth/console-sessions/current`；页面本身是 `GET /` 与 `/assets/*` |

## 已实现的能力

- React + Vite 构建的静态单页（`pnpm build:console` 输出到 `packages/console/dist`），守护进程启动时索引产物并在同一端口提供；没有构建产物时页面返回 503 并说明构建命令，API 照常工作；重新构建后需重启守护进程。
- 每个页面有自己的地址（如 `/providers`、`/routing/keys`、`/usage/conversations`、`/settings/backup`、`/tasks`），可刷新、收藏与前进后退；早期地址自动改写。只有 `Accept` 含 `text/html` 的 GET 回退到 `index.html`，`/api`、`/v1`、`/health`、`/assets`、`/openapi.json` 与模型网关路径从不回退。
- 页面响应带只允许本源脚本的 CSP、`nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY` 与同源的 COOP/CORP；主题脚本是单独的 `/theme-boot.js`。
- 登录：登录码在 URL 片段 `#login=` 中，页面读取后立即从地址栏清除，换取浏览器 Cookie 与本标签页的会话令牌（存 `sessionStorage`），两者缺一不可；每个标签页分别登录，退出只结束本标签页；没有会话时只提示运行 `hh console`，不提供口令表单。
- 网关页面经 `@harnesshub/sdk` 以控制台会话访问 `/api/v1`；任务页面仍经 `lib/api.ts` 访问旧 `/v1/*` 接口。
- 中英文界面：设置 → 语言，选择存于本浏览器的 `localStorage`，未选择时按浏览器语言取第一个中文或英文，其他语言用英文；日期、数字与金额按所选语言格式化；守护进程返回的说明按原文显示。
- 侧栏可切换浅色与深色，选择存于 `localStorage`，首帧前由 `theme-boot.js` 应用；窄屏改用导航菜单与抽屉，尊重 `prefers-reduced-motion`。
- 状态：任务页的状态条每 5 秒探测 `/health/ready`；接口不存在（Fastify 路由 404）时显示“当前 Gateway 不支持”，业务 404 仍按错误显示；列表为空时显示说明与下一步。
- 写入约定：改写 Agent 配置的操作（接线、切换模型、应用 Profile、首次使用、Library 同步）先显示 diff 再确认；恢复备份先预览摘要；还原、换 Key、删除与吊销、开启局域网共享、关闭出站脱敏、关闭同步等先确认，与 `hh` 的 `[y/N]` 一致。
- 反馈：失败在对话框内显示守护进程的说明，或在右下角以通知显示，“技术详情”含错误码与请求 ID；成功的操作也以通知确认。
- 开发：`pnpm start:local --dev` 同时启动守护进程与 127.0.0.1:3330 的 Vite 开发服务器，后者把 API 路径转发给守护进程并保留原 Host。
- 厂商与 Agent 标志在构建时打包进控制台，页面不从其他来源加载资源。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/console/components/console.tsx](../../../packages/console/components/console.tsx)、[packages/console/lib/router.ts](../../../packages/console/lib/router.ts)、[packages/console/lib/session.ts](../../../packages/console/lib/session.ts)、[packages/console/lib/i18n.ts](../../../packages/console/lib/i18n.ts)、[packages/console/lib/toast.ts](../../../packages/console/lib/toast.ts) |
| 守护进程 | [packages/daemon/src/http/console-static.ts](../../../packages/daemon/src/http/console-static.ts)、[packages/daemon/src/http/console-session.ts](../../../packages/daemon/src/http/console-session.ts) |
| 测试 | [tests/integration/console.test.ts](../../../tests/integration/console.test.ts)、[packages/daemon/test/console-session.test.ts](../../../packages/daemon/test/console-session.test.ts)、[tools/check-console-contracts.test.mjs](../../../tools/check-console-contracts.test.mjs)、[tools/check-console-i18n.test.mjs](../../../tools/check-console-i18n.test.mjs)、[tools/check-console-routing.test.mjs](../../../tools/check-console-routing.test.mjs)、[tools/check-console-environment.test.mjs](../../../tools/check-console-environment.test.mjs) |
| 决策 | [ADR 0024 控制台内嵌守护进程与控制台会话](../../decisions/0024-embedded-console.md)、[ADR 0034 控制台的中英文界面](../../decisions/0034-console-languages.md) |

## 已知限制与未验证

- 从其他网站的链接打开控制台得到 403 `LOCAL_ACCESS_REQUIRED`：守护进程拒绝一切带 `Sec-Fetch-Site: cross-site` 的请求，包括浏览器整页打开页面；从终端 `hh console` 打开不受影响。是否放宽待所有者决定（[TODO 所有者事项](../../../TODO.md#需要所有者处理的事项)）。
- 没有真实浏览器的自动回归测试：ADR 0024 与 0034 的浏览器验证是一次性人工或无头走查。
- 没有远程控制台：管理 API 只接受回环连接。会话只在守护进程内存中，重启后需要重新登录。
- 任务页面使用的旧 `/v1/*` 接口不要求会话，只校验回环 Host 与同源 Origin（ADR 0024 决定 4）。
- 没有桌面应用、托盘与 Agent 自己会话文件的页面。
- Windows 上未运行过控制台。

## 优化候选

- **现状**：跨站链接打开控制台一律 403。**方向**：只放行指向页面路径的整页 GET 导航（只得到不含数据的 `index.html`），其余跨站请求照旧拒绝，同时修订 07 第 5.3 节与 `console.test.ts` 的断言。**依据**：[TODO 所有者事项](../../../TODO.md#需要所有者处理的事项)中的放宽方案。
- **现状**：控制台没有浏览器自动测试。**方向**：按计划接入 Playwright，从构建产物启动 `hh serve`，覆盖两种视口、中英文、深色模式与 axe 检查。**依据**：[10 第 3.6 节](../../proposals/oss/10-engineering.md#36-控制台浏览器测试)、ADR 0024“后果”。
- **现状**：任务、引擎、工具与观测页面走旧 `/v1/*`，不受控制台会话保护。**方向**：随执行 API 迁到 `/api/v1`，改由 SDK 与会话访问。**依据**：[ADR 0024](../../decisions/0024-embedded-console.md) 决定 4。
- **现状**：没有 Agent 自己会话文件的页面。**方向**：评估是否提供只读的会话浏览。**依据**：[对照表](../../magpie-parity.md#terminal-ui-and-console) Pages 一行（部分）。
- **现状**：主题缺省为浅色，不跟随系统的深浅色设置，深色只能在侧栏手动切换。**方向**：没有保存过选择时按 `prefers-color-scheme` 决定，首屏脚本同样处理以免闪烁。**依据**：阅读 [theme-script.ts](../../../packages/console/lib/theme-script.ts) 的注释“the system preference is not consulted”。
