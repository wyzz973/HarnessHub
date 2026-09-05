# 验收：使用、架构、API 文档与 GitHub 交付

日期：2026-09-05。范围：HH-039；基线 `39aa243` 加当前引擎发现、独立配置及文档变更。负责人：主 Agent；文档另经独立只读读者检查。当前记录证明本地文档与 Mac 验证；GitHub 发布和远端 CI 在实际完成后补充。

## 交付内容

[README](../../README.md)与[使用指南](../getting-started.md)说明新克隆安装、无 Key demo、真实引擎、数据目录和排障。[架构导览](../architecture.md)给出模块地图、请求时序、配置版本、秘密解析、状态和恢复；设计基线保留架构约束。[API 文档](../api/README.md)覆盖正式组合根的 40 个 HTTP 操作，逐项描述输入输出、实现调用链、持久化与副作用、错误及源码/测试入口，生成 OpenAPI JSON。

API 人工说明只有 `api-catalog.ts` 一个来源，schema 继续由所属路由与 domain 拥有；生成及新鲜度检查进入 `pnpm check`，拒绝样例覆盖漏记、过期路由、重复项、失效/越界指针和无效 OpenAPI 类型。另补贡献指南、第三方来源与许可状态，保留历史实现及验收内容。

读者检查发现并修正：demo 首次必须选择“直接执行”后使用 fake；工作流 curl 示例应使用教程的 3180；API 审批说明需明确重复审批幂等，任一步骤失败会阻塞全部尚未执行步骤。修改说明后重新生成并检查 API 文件。

## 独立目录验证

环境：macOS 26.6.2 arm64、Node 24.20.0、pnpm 10.12.3。把 222 个拟提交文件复制到随机临时目录，不带 `.tools`、`node_modules`、数据库、本机配置、构建缓存；使用固定 Node 执行 `pnpm install --frozen-lockfile`，安装通过。临时目录与端口独立，不替换现有 3184/3330 服务。

| 检查 | 实际结果 |
|---|---|
| `pnpm check` | 首次在格式检查发现新配置路由的排版问题；格式化该文件后，从该阶段继续执行全部剩余检查 |
| `pnpm check:runtime`、`pnpm lint` | 通过；Node 与固定版本一致 |
| `pnpm format:check`、`pnpm check:boundaries`、`pnpm check:docs` | 通过 |
| `pnpm test` 内的 `build` | TypeScript 与 macOS Keychain helper 编译通过 |
| `test:tooling` / `test:unit` / `test:integration` / `test:smoke` | 27 / 36 / 73 / 3 项通过；合计 139，0 失败、0 跳过 |
| `pnpm check:api` | 40 项操作与正式 Gateway 双向覆盖，生成内容一致 |
| `pnpm check:console` | 前端 lint、Next 生产构建和 TypeScript 通过 |
| `pnpm docs:api` 后 `format:check`、`check:api` | 工作流说明修正后再次通过；文档字符串修改不改变执行语义 |
| `git diff --check` | 通过 |

原始日志保存在本机临时目录 `harnesshub-publication-xbah2zw9`，不随 Git 发布。自动测试保留真实 HTTP/SQLite/IPC/Worker，外部模型使用确定替身；此轮没有调用真实付费模型。

## README 实际操作

从编译产物启动独立 demo Gateway，执行 `node examples/http-lifecycle.mjs <实际URL>`：Run completed；相同幂等 key 返回同一 Run；9 条事件连续；SSE 重放与 JSONL 一致；下载文本产物 SHA-256 为 `49a705c83cba88ad4504499b59a64790a6ad2b8deb3f837ada6bb56b061bf76a`，字节与输入相符；示例关闭了所属 Session。

从生产前端构建启动独立 Console，显式设置 Gateway URL。在新的浏览器上下文按文档选择“直接执行”→fake→发送 `README_DEMO_OK · 中文快速开始验证`。页面显示已完成；刷新仍显示相同任务和回复；HTTP 持久记录为 completed、cleanupStatus=confirmed、lastSeq=6。浏览器无 error/warn。测试 Session、浏览器页、前端和 Gateway 均已关闭。

## 发布检查与边界

Gitleaks 8.30.1 的 macOS arm64 二进制来自官方 release，并核对其公布 SHA-256。扫描全部 8 个现有 Git 提交和拟提交源码目录，均未发现凭证命中；另外审查文件清单，未纳入运行数据库、轨迹、截图、日志、私有配置或引擎安装。此检查降低泄漏风险，不是对所有形式敏感信息的绝对保证。

GitHub 仓库按用户明确选择设为 public，目标为 `wyzz973/HarnessHub`。自有代码尚未指定开源许可证，公开访问不等于授予开源许可；本次不发布 npm 包。

Windows 原生监督、运行和发行未验证；其他真实引擎/远端模型的结果沿用各自注明环境的历史记录，本次自动检查不能替代它们。远端 CI 结果以对应 GitHub Actions 运行记录为准。
