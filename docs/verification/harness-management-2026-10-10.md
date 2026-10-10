# Harness 集中管理与工作台验收

日期：2026-10-10，macOS arm64，Node 25.9.0、pnpm 10.12.3、TypeScript 5.9.3。基线 `42e9ddd`，当前切片为 ADR-012，分支 `codex/local-discovery`。新项目位于 HarnessGateway；旧 HarnessHub 的既有改动保持原样。完整未来工程门禁仍为 false。

## 已交付行为

- 图形工作台重新设计：统一字号与留白、可折叠侧栏、品牌 SVG、可搜索且支持键盘的选择浮层、Provider 编辑页、Harness 管理列表与任务详情侧板。细微过渡尊重 reduced-motion，320/390px 移动布局单独检查。
- Harness 集中安装、检查更新、升级、查看持久阶段/日志与取消。系统程序的包版本证据优先；明确检查才在私有环境执行有界 `--version`，不把 Node 或目录名字当产品版本。
- 后台安装管理拥有独立 SQLite 记录、任务身份、命令幂等、默认 revision 与不可变版本槽。刷新/关页面不拥有进程；失败、取消、未知、完成分别记录。重启不重放未知任务。
- npm/Python/归档的审核配方、官方元数据与版本固定。每次安装使用唯一最终位置作为逻辑 stage，避免移动 uv/npm 安装树破坏绝对路径；验证和事务发布前不可被发现为受管默认。
- 安装升级实际接入正式 Session Binding。显式 control 与 manifest override 保持独占；未指定 control 的新选择优先唯一受管入口，多个未受管入口仍需要选择。HTTP `defaultControlId` 与浏览器初选一致。这是同一个 Harness 的入口默认，不是自动择优 Harness。
- 每轮在真正启动 Driver 前提交 `run.installation_resolved`，记录 managed 身份/revision/version 或 system 来源。已捕获的命令和旧版本目录不因后续升级被覆写。

## 实际检查

| 命令 | 最终结果 |
|---|---|
| `pnpm build` | 严格后端 TypeScript 通过 |
| `pnpm web:build` | 前端 TypeScript 与生产构建通过；最终浏览器验收使用生产资产 |
| `node --test dist/tests/*/*.test.js` | **365 通过，0 失败、0 跳过**，约 6.4s |
| `node --test dist/tests/real/*.real.js` | **6 通过，0 失败、0 跳过**；含真正 npm 安装与升级，约 55.3s |
| `pnpm test:web`，最终修正后再以 `pnpm build`、`pnpm web:build`、`node --test dist/tests/browser/web.browser.js` 验收 | **1 个完整浏览器场景通过，0 失败、0 跳过**，最终约 25.0s |
| `python3 tools/check_design.py --write` / 默认检查 | 26 需求、81 任务、309 planned 场景、5 个获准切片；完整实现门禁 false。场景蓝图不是运行结果 |
| `python3 -m unittest discover -s tools -p 'test_*.py' -v` | **33 通过**；检查器含无效输入与越界反例 |
| `git diff --check` | 通过 |

运行日志与截图保存在忽略目录 `.tmp/`、`artifacts/web-v2/`；临时安装、测试凭据与运行数据不进入 Git。

## 后端证据

新增默认用例覆盖管理状态/数据校验、真实 SQLite 事务/幂等/CAS、取消与关闭、超过 1000 条记录的重启恢复、失败不发布、未知不重跑、日志水位与 UTF-8 分片、真实进程退出/后代清理、owner 丢失、归档 traversal/链接/体积/损坏、安装 receipt/路径/argv/env/版本篡改。管理 own 27 项、HTTP 新 9 项、系统版本 10 项及发现组合 1 项纳入最终 365 项。

系统版本的 10 项保持真实 CLI 子进程；覆盖 package 证据无需启动、native 与已知 Node 入口、stderr、歧义、unsupported、5 秒期限、取消、64KiB 溢出和所有权丢失后实际 PID 清理。系统版本 1.2.3 对发行版本 2.0.0 形成 available；不会修改默认指针或创建安装任务。

发现组合用独立进程和私有 PATH 核对 managed 覆盖同控制入口的系统程序，其他控制入口同时存在时未指定选择仍使用 managed。明确选择另一个控制入口保持有效；blocked override 不回退受管版本。只读观察不启动 Harness。

## 真正安装与执行

新 `test:real:install` 从官方 npm 下载 **Codex 0.160.0 → 0.162.1**，使用实际 npm 安装器、包锁完整性与入口校验，分别创建两个私有版本槽。为了固定验收版本，仅元数据端口指定这两个官方 exact-version；包安装、文件、数据库、Binding、Runtime 和 Driver 均保持真实。

先用第一版运行一轮，再升级并用第二版运行下一轮。两次实际请求到达本地 Responses SSE 端点；每次 endpoint/model/key 核对。第二轮收到第一轮公共上下文，Session 不变；两个 `run.installation_resolved` 依次记录 0.160.0、0.162.1，默认 revision=2，旧入口字节不变，两轮 completed 与 cleanup.closed 分别确认。

既有五项真实 Harness 验收一并重跑，包括真实 Codex 三轮跨 CLI 续接、Provider A→B→编辑后 A、Gemini，以及同 Session 的 Codex→Gemini→Codex。它们使用本地确定性模型服务及合成私有 key，未调用真实云模型、未读取个人登录配置。完整历史接续等级仍是 public_context_rehydrate。

## 前端证据

使用 Playwright 1.64.0 / Chromium 1248 的真实浏览器，加载生产资产；自有 HTTP/SQLite/Runtime/Driver/管理任务保持真实，只用夹具替代外部 Harness、模型目录和安装仓库/程序。

实际操作覆盖 Provider 新增、编辑、目录检查、旧 revision 保持与显式更新、同 Session 模型切换、取消、停用、不兼容选项、刷新续接、IME/Shift+Enter，以及安装 1.0.0→检查最新 2.0.0→升级完成→显示当前已是最新/禁用重复升级。真正安装进程的输出进入持久日志。故意丢失已提交切换的 HTTP 响应并延迟读响应，重试复用相同 commandId，只形成一个有效 epoch；无非预期页面或控制台错误，浏览器 storage 与可见内容不含合成 key。

搜索浮层覆盖搜索无结果、组合输入 Enter 不选中、方向键/Enter 选择、Escape 关闭与焦点恢复；320px 浮层实际边界保持在 viewport 内。媒体设为 reduced-motion 后，实际计算的过渡/动画时长不超过 1ms。窗口变化触发浮层重新定位，测试等待可观察的最终几何边界，不用未稳定的一帧冒充布局失败或降低边界断言。

初始、Provider 编辑/列表、对话、Harness 列表在 320/390px 无横向溢出；已有会话 resize 后 scroll 跟到最新回复。桌面、移动编辑页、移动聊天、浮层及安装/升级详情截图已实际审阅。修正了移动页头裁切、中文字图标换行、移动输入高度、resize 回复被遮挡、默认受管入口未优先及升级后陈旧 available 状态。

截图位于 `artifacts/web-v2/`，主要包括 `initial-desktop.png`、`providers-desktop.png`、`harnesses-desktop.png`、`provider-editor-320.png`、`chat-390.png`、`harness-picker-320.png`、`install-detail.png`、`upgrade-detail.png`。安装/升级 UI 截图中的 Autohand 1/2 版本属于明确夹具，不作为其真实发行版或下载验收。最终 CSS 44.95KB/gzip9.71KB，入口 JS425.44KB/gzip135.36KB，Markdown 独立 chunk116.94KB/gzip35.44KB。

## 来源与依赖

产品流程依据固定 Magpie/CC Switch 源码和公开页面，见[调研](../research/harness-management.md)。Magpie 当前 Agent 页安装配方生成命令，后台升级才真正执行；我们的安装按钮执行持久后台任务。品牌素材本地构建，来源、hash、许可与通用首字标识的区别见 [THIRD_PARTY_ASSETS](../../web/THIRD_PARTY_ASSETS.md)。

| 本次新增固定依赖 | 许可 | 当前用途 |
|---|---|---|
| `@lobehub/icons-static-svg@1.95.1` | MIT，品牌权利另计 | 本地 SVG |
| `@radix-ui/react-popover@1.2.0` | MIT | 选择浮层/焦点管理 |
| `semver@7.8.5` / types 7.8.0 | ISC / MIT | 版本与 engines |
| `tar@7.5.22` | BlueOak-1.0.0 | gzip tar 受限提取 |
| `yauzl@3.4.0` / types 3.4.0 | MIT | 受限 ZIP |
| `unbzip2-stream@1.4.3` / types 1.4.3 | MIT | 受限 bzip2 |

依赖来自 npm，使用精确版本与 pnpm 锁文件；现有 React/Vite 工具链保持原版本。许可从安装包记录核对，未使用浮动版本或运行时图标 CDN。

## 已知边界

当前目录为 43 产品、47 控制入口；管理注册为 46 配方（25 npm、19 binary、2 Python）。当前宿主观察有 42 个产品具备可提交安装动作，Kimi 旧入口已归档，等待新 Kimi Code 配方审核。这个数量是可解析配方，**不是 42 个真实下载、登录、协议或任务组合通过**。

真实下载安装验收为上述 Codex npm 两版本；其余产品、Python 实包、归档实包、私有 Node24 下载的真实外部组合尚未逐个运行。共享归档/进程/存储边界有合成集成证据。上游有 SHA 则必须匹配；没有上游 SHA 的归档仅记录 HTTPS 来源及实际摘要，不伪称官方 checksum 通过。

本机现有系统安装继续发现；“更新并管理”建立网关私有新版，保留系统版。当前不做系统全局升级、卸载/版本 GC、批量自动升级或所有发行平台。npm 槽若引用宿主 Node 实路径，未来宿主 Node 路径改变需重新检查，不静默改换 runtime。安装完成表示包/版本/入口验证与默认发布，登录、Provider 兼容与任务正确性分别验证。

自动择优、完整权限/代理/账本、真实云模型质量与 Windows 验收仍后置；未验证项不标完成。
