# HarnessHub Console

控制台采用 Next.js 16.3.4、React 19.2.8、Tailwind CSS 4.3.3、shadcn/ui、assistant-ui 0.15.18、AI Elements、Streamdown 2.6.0 和 Lucide。执行状态来自原 Gateway；前端的 assistant-ui ExternalStoreRuntime 仅负责消息呈现与 Composer 交互，不引入第二套 Agent Runtime。

## 运行

在项目根目录使用 Node 24.20.0 / pnpm 10.12.3：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
```

先启动 Gateway，再在另一个终端启动控制台。以下是本机已准备的配置和实际端口，配置文件不包含密钥，仅包含本机路径引用：

```sh
pnpm start --config engines/console.local.yaml --data-dir data/console --port 3184
HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3184 pnpm start:console
```

页面位于 `http://127.0.0.1:3330`。开发页面使用 `pnpm dev:console`；后台地址环境变量相同。未设置环境变量时代理连接 `http://127.0.0.1:3182`。`engines/console.local.yaml` 是本机忽略文件，新环境需要按 [配置说明](../docs/engine-management.md)准备自己的引擎和工作区。前后端均绑定 loopback，原有 3000 端口的服务没有被占用或替换。

## 页面与状态

- 任务工作台：自动规划/直接执行、引擎和工作区选择、任务历史、流式正文、思考展开、工具详情和实际权限请求。
- 自动计划：先展示步骤、依赖、产物与选择依据，确认后执行；失败或取消不偷偷重试。
- 执行详情：模型、阶段耗时、token、费用来源、安装版本、覆盖缺口、产物下载和轨迹导出。
- 引擎管理：发现、注册、启停、默认选择和热加载；安装证据不等于模型可用。
- 运行观测：真实状态计数、负载、p50/p95、已知 token 与样本覆盖、按 Run 追溯。

当前任务 ID 保存在 URL 中，刷新从持久数据恢复。SSE 使用真实命名事件与序号，40ms 合并显示更新；网络断开时以事件游标和持久查询追赶。关闭页面不取消任务，停止按钮才发出取消请求。没有生成静态伪任务、伪曲线或用零代替未知用量。

界面使用浅色主题、清晰焦点、中文标签和克制过渡，尊重 `prefers-reduced-motion`，窄屏改用导航菜单与抽屉。控制台是本机应用，尚未加入远端多用户认证、完整账单对账或全平台桌面发行。

## 组件来源与许可

`components/ui` 基于 [shadcn/ui 官方 registry](https://ui.shadcn.com/)，保留 [MIT 许可](licenses/shadcn-ui.txt)。`components/ai-elements` 来自 [Vercel AI Elements](https://github.com/vercel/ai-elements)，用于 Reasoning、Sources、Tool、Artifact、Plan 与代码块；保留 [原始许可声明](licenses/ai-elements.txt)和 [Apache 2.0 完整条款](licenses/apache-2.0.txt)。已修改本地 import、类型边界、异步事件处理和中文呈现，文件头明确标注适配。

Thread、Message、Composer 与前端状态适配使用 [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)；Markdown 使用 [Streamdown](https://streamdown.ai/)。包版本由根目录 pnpm workspace 锁统一管理。组件生成源码随 Git 固定，不在运行时拉取 registry。
