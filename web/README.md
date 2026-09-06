# HarnessHub Console

控制台采用 Next.js 16.3.4、React 19.2.8、Tailwind CSS 4.3.3、shadcn/ui、assistant-ui 0.15.18、AI Elements、Streamdown 2.6.0 和 Lucide。执行状态来自原 Gateway；前端的 assistant-ui ExternalStoreRuntime 仅负责消息呈现与 Composer 交互，不引入第二套 Agent Runtime。

## 运行

在项目根目录使用 Node 24.20.0 / pnpm 10.12.3：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
```

Windows 可直接用 `pnpm start:local --demo` 同时启动两个服务，固定本地 Node 与 PowerShell 调用见 [Windows 启动说明](../docs/windows.md)。

手动分别启动时，先启动 Gateway，再在另一个终端启动控制台。新克隆可直接使用以下 demo，不需要本机配置或 API Key：

```sh
pnpm start --demo --data-dir data/demo --port 3180
```

第二个终端在仓库根目录运行：

下面使用 POSIX 环境变量语法；Windows 按 [PowerShell 启动说明](../docs/windows.md) 设置环境变量。

```sh
HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3180 pnpm start:console
```

页面位于 `http://127.0.0.1:3330`。开发页面使用 `HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3180 pnpm dev:console`。未设置环境变量时代理保留历史兼容默认 `http://127.0.0.1:3182`，新环境应显式指定。真实引擎的自有配置按 [配置说明](../docs/engine-management.md)准备。

demo需将“执行模式”切为“直接执行”，选择fake后发送文本；页面默认“自动规划”，该模式会排除fake，需要另行登记真实引擎。

历史验收服务使用3184与忽略的`engines/console.local.yaml`，它不随仓库提供，不是首次运行前提。macOS的Keychain helper需要Xcode Command Line Tools；通用前置条件见 [快速开始](../README.md#快速开始不需要-api-key)。前后端均绑定loopback。

## 页面与状态

- 任务工作台：自动规划/直接执行、引擎和工作区选择、任务历史、流式正文、思考展开、工具详情和实际权限请求。
- 自动计划：先展示步骤、依赖、产物与选择依据，确认后执行；失败或取消不偷偷重试。
- 执行详情：模型、阶段耗时、token、费用来源、安装版本、覆盖缺口、产物下载和轨迹导出。
- 引擎管理：进入页面主动发现，可见期间每分钟及重新可见时刷新；注册、启停、默认选择和热加载。识别清单与各引擎接入方式见 [本机发现](../docs/engine-discovery.md)，安装证据不等于模型可用。每行支持 [独立配置与检查](../docs/engine-configuration.md)，可编辑模型、Provider、Keychain/环境/文件密钥引用、Skills 和 MCP。
- 运行观测：真实状态计数、负载、p50/p95、已知 token 与样本覆盖、按 Run 追溯。

当前任务 ID 保存在 URL 中，刷新从持久数据恢复。SSE 使用真实命名事件与序号，40ms 合并显示更新；网络断开时以事件游标和持久查询追赶。关闭页面不取消任务，停止按钮才发出取消请求。没有生成静态伪任务、伪曲线或用零代替未知用量。

界面使用浅色主题、清晰焦点、中文标签和克制过渡，尊重 `prefers-reduced-motion`，窄屏改用导航菜单与抽屉。控制台是本机应用，尚未加入远端多用户认证、完整账单对账或全平台桌面发行。

## 组件来源与许可

`components/ui` 基于 [shadcn/ui 官方 registry](https://ui.shadcn.com/)，保留 [MIT 许可](licenses/shadcn-ui.txt)。`components/ai-elements` 来自 [Vercel AI Elements](https://github.com/vercel/ai-elements)，用于 Reasoning、Sources、Tool、Artifact、Plan 与代码块；保留 [原始许可声明](licenses/ai-elements.txt)和 [Apache 2.0 完整条款](licenses/apache-2.0.txt)。已修改本地 import、类型边界、异步事件处理和中文呈现，文件头明确标注适配。

Thread、Message、Composer 与前端状态适配使用 [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)；Markdown 使用 [Streamdown](https://streamdown.ai/)。包版本由根目录 pnpm workspace 锁统一管理。组件生成源码随 Git 固定，不在运行时拉取 registry。
