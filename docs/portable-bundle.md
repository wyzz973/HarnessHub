# Windows 便携发布包

本页的构建流程在开发机执行。裁判机使用包内运行时和已准备的程序文件，不执行依赖安装、源码编译或运行时下载。模型凭证和目标引擎的实际可用性由运行配置与验收结果分别说明。

发布清单包含 16 个引擎模板，不表示 16 个引擎都支持同一种比赛 API。统一 Provider 的协议范围见 [引擎配置矩阵](engine-configuration.md)：Gemini 需要 Google 协议；Cursor、Antigravity、Kiro、Qoder 保留原生认证与 Provider 配置；Kimi 自定义 Provider 使用 CLI 模板。未配置且未验证的引擎不能仅凭打包成功作为比赛可用引擎。

## 构建

在开发机使用与 Windows 系统、目标包架构一致的 Node 24.20.0（ARM64 或 x64）。当前总入口不支持在 ARM64 机器通过 x64 Node 交叉制备 x64 包。Node 使用官方完整解压目录，`node.exe` 旁须有同版 `LICENSE`。后端、Windows 原生 helper 和控制台 standalone 也须在打包前构建；`web/next.config.ts` 的 tracing root 覆盖仓库根，构建器保留 standalone 的实际层级并另外复制静态资源。

一键制备入口是 [prepare-contest.mjs](../scripts/prepare-contest.mjs)。下面从仓库根运行，ARM64 默认输出 `.tools/contest-prepared/win32-arm64`，x64 使用相应 Node 目录和 `win32-x64`。第一次制备可能下载固定依赖，仅在开发机运行：

```powershell
& '.tools/node-v24.20.0-win-arm64/node.exe' scripts/prepare-contest.mjs
& '.tools/node-v24.20.0-win-arm64/node.exe' scripts/prepare-contest.mjs --check
```

`--root` 可指定本仓库 `.tools` 或 `.tmp` 下的子目录；`--arch` 如显式填写，必须等于当前原生 Node/Windows 架构。默认使用运行此脚本的 Node 同目录 Corepack 的 `dist/pnpm.js`，直接由该 Node 执行，先确认返回的 pnpm 版本恰好是 10.12.3。也可用 `--pnpm <pnpm.cjs 或 pnpm.js 的绝对路径>` 提供本地入口，仍验证实际版本。不会调用 PATH 中的 pnpm.cmd、全局临时 shim 或改变全局 PATH。默认首次制备允许 Corepack在开发机获取该固定 pnpm；`--check` 禁止 Corepack 联网，缓存未准备好时明确失败。

总入口按以下顺序处理，任何外部命令非零退出都会终止：

1. 复制当前固定 Node 和 LICENSE 到 `runtime`；已有文件必须与输入逐字节一致。
2. 将 [固定 package.json](../distribution/npm/package.json) 与 [pnpm-lock.yaml](../distribution/npm/pnpm-lock.yaml) 复制到 `engines/npm`，执行 pnpm 10.12.3 的 `install --frozen-lockfile --ignore-scripts --ignore-workspace --config.node-linker=hoisted --package-import-method=copy --prod`。安装后再次验证锁文件、顶层精确版本、pnpm版本和hoisted安装图，不能通过重新解析最新版本绕过锁文件。
3. 调用 [prepare-binaries.mjs](../scripts/prepare-binaries.mjs) 的 `--root --arch`，准备固定二进制引擎。
4. 分别调用 [prepare-extra-engines.ps1](../scripts/prepare-extra-engines.ps1) 的 `-TargetRoot -Engine hermes/kiro`，使用锁定 wheel 闭包和只读 MSI 解包流程，不在系统注册 Kiro 产品。
5. 调用 [prepare-git.mjs](../scripts/prepare-git.mjs) 的 `--root --arch`，准备 PortableGit 及来源 receipt。
6. 调用 [prepare-openclaw.mjs](../scripts/prepare-openclaw.mjs) 的 `--package`，仅完成固定 OpenClaw 的官方 lifecycle；这是明确的开发机步骤，npm总体安装仍禁用自动生命周期脚本。
7. 将仓库 [工具包示例](tool-packages.md) 的实际文件复制到 `tools`，将 [vendor-notices](../distribution/vendor-notices) 的固定许可证与来源记录复制到各引擎的同名目录，再调用 [prepare-engine-catalog.mjs](../scripts/prepare-engine-catalog.mjs) 的 `--root --arch`，最后生成只含相对模板的 `prepared.json`。

同一 root 的并发制备会被 `.prepare-contest-lock` 拒绝。已完成的 binary、Hermes/Kiro 和 Git准备可根据固定来源 receipt、版本、架构及必要文件检查复用；不会仅凭目录存在就视为成功。部分目录、过期 receipt、不同 runtime 或残留多余工具文件明确失败，需检查后选新 root。原 `prepared.json` 会先保存为带 UUID 的 `prepared.previous.*.json`；失败时本轮生成的 catalog 转为 `prepared.failed.*.json`，不给失败目录保留可打包的正式 catalog。正常流程等待各子命令结束后释放锁；崩溃残留锁需要先确认 owner 已退出，再显式清理。不要在制备进行时运行打包命令。

`--check` 不运行下载器、安装器或 catalog 生成器，不更新 prepared 文件；它验证本地 runtime/LICENSE、固定 npm输入和安装元数据、准备receipt/必要入口、OpenClaw pending标记、工具副本和最终catalog，成功输出 `checked:true`、`downloads:false` 和 `modelCalled:false`。它不等于每个引擎的实际模型验收，也不替代后续发行目录的全量hash检查。缺文件、版本不符或不完整状态均退出 1，不静默重装。入口参数与失败路径由 [check-prepare-contest.test.mjs](../scripts/check-prepare-contest.test.mjs) 验证。

准备目录必须有 `prepared.json`，其中 `schemaVersion=1`、`platform=win32`、`arch=arm64/x64`、`nodeVersion=24.20.0`，并提供引擎配置模板数组 `engines` 和来源/许可证组件数组 `components`。实际程序放在 `runtime`、`engines`、可选 `bin`、可选 `tools`；`runtime/node.exe` 的实际版本、平台和架构必须与元数据一致。

```powershell
& '.tools/node-v24.20.0-win-arm64/node.exe' scripts/package-bundle.mjs --prepared '.tools/contest-prepared/win32-arm64' --output 'C:\build\HarnessHub-new'
```

`--output` 必须不存在，父目录必须已存在；构建器不覆盖现有发行目录。失败会保留带 `.incomplete` 标记或缺少有效 `bundle.json` 的结果供诊断，不应分发。成功输出包含根 `dist/src`、`dist/native`、所需 `scripts`、生产依赖、console standalone 及准备目录白名单内容。

Gateway 和控制台的生产依赖均依据当前固定安装图物化，不重新向 registry 解析版本。具有版本冲突的依赖保留在 Node 的嵌套依赖作用域，已安装但未被生产依赖图引用的开发包不会复制。Windows 下 Next standalone 的 pnpm 链接不直接复制，构建器保留应用产物并重新物化控制台生产依赖。内部链接只可指向已知输入根，输出是普通文件；越界链接、循环链接使构建失败。打包按目标架构保留各依赖 `prebuilds/win32-arm64` 或 `prebuilds/win32-x64` 分支，并移除 pnpm 安装元数据和 Python 字节码缓存；普通 SDK 的 `sessions`、`logs` 源码目录与许可证仍保留。留下的每个 native addon 都校验实际 PE 架构，目录标签错误仍使打包失败。不能用复制本机 `.bin` 绝对路径 shim 代替这个过程。

Kimi 1.50.0 的 Apache 2.0 LICENSE/NOTICE 和 OpenCode v1.18.29 的 MIT LICENSE 来自官方固定 tag 解析后的 commit，原文字节及 SHA-256 记录在各 `vendor-notices/source.json`。Antigravity、Cursor 和 Kiro 的同目录说明明确列出版本、原始分发地址、hash 和官方条款链接；没有可附的版本化许可原文时记录 `originalLicenseTextIncluded:false`。这些说明不授予额外再分发权，也不替代原产品条款。

Pi 固定组合为 `@earendil-works/pi-coding-agent@0.85.1` 与 `pi-acp@0.0.33`，包内入口为 `dist/bundle/cli.js`。旧 Pi 0.73.1 不发送此 Adapter 完成请求所需的 `agent_settled` 事件，不能仅替换启动路径继续使用。新版本的 API Key 配置使用 `$HARNESSHUB_PROVIDER_KEY` 环境插值；显式 MCP 使用随包本地扩展，见 [原生 MCP](native-mcp.md)。

构建器不会复制源码仓库的 HOME、data、数据库、原生个人账号配置、`.env` 或本机发现注册。Next 写入的构建目录字段会替换成由服务器自身位置计算的目录；可执行文本与元数据中残留开发者 HOME、仓库或 prepared 绝对路径时构建失败。准备目录内的引擎配置模板必须使用运行时支持的占位符。`bundle.json` 记录组件、目标架构、console 入口和每个普通文件的大小及 SHA-256，自身不参与递归 hash。打包 ZIP 时必须完整保留此目录结构。

## 构建检查

```powershell
& '.tools/node-v24.20.0-win-arm64/node.exe' --test scripts/check-bundle.test.mjs
```

检查包含移除源依赖后从新目录加载相互冲突的生产依赖、workspace pnpm 链接的依赖作用域、内部链接物化、链接越界/循环拒绝、已有文件不覆盖、错误 native addon 架构拒绝和 Next 目录字段搬迁。每次真实构建还会使用输出目录中的 Node，从其他 cwd 且不含开发者 PATH/NODE_PATH 的子进程导入打包后的 Gateway，并由包内 Job helper 启动控制台，检查页面与静态 JS 的 HTTP 200 后等待进程清理。完整发行入口、UI 交互、引擎初始化、文件任务、取消和搬迁后的运行恢复须由发布验收另行证明。

## OpenClaw 准备与运行边界

固定 `openclaw@2026.9.2` 在 `--ignore-scripts` 安装后，必须在构建机执行 `node scripts/prepare-openclaw.mjs --package <OpenClaw包目录>`。此入口调用该版本包内的官方 lifecycle 完成函数并确认 pending 标记消失；裁判机启动器遇到未完成标记会明确失败，不在首次运行时安装。

`launch-openclaw-bundled.mjs` 接收绝对 `openclaw.mjs` 路径，使用包内 Node、随机 loopback 端口和仅环境传递的随机内部 token，先检查本地 Gateway 就绪，再连接 ACP。stdout 只承载 ACP；Gateway 日志走 stderr，内部 token 被替换。两条子进程树分别由 Windows Job 持有，EOF、子进程异常及封装进程死亡均清理所属后代。它只接受明确的私有 `OPENCLAW_STATE_DIR` 和位于其内的 `OPENCLAW_CONFIG_PATH`，不连接个人 Gateway。

统一 Provider 支持 OpenAI Completions、OpenAI Responses 和 Anthropic Messages；必须提供 base URL 和 model。生成的每 Session 配置使用 OpenClaw 的环境 SecretRef，密钥仅在子进程环境中；内置目录刷新、自动更新和定时任务关闭，模型在用户 Run 时调用。显式 MCP 写入原生 Gateway 的 `mcp.servers`，不重复通过 ACP 下发；不能把成功初始化当作工具或模型调用成功。

## 公司开源发行版

先完成上述固定程序制备，再运行 `node scripts/prepare-open-source.mjs --prepared .tools/contest-prepared/win32-arm64 --output .tools/open-source-prepared/win32-arm64`。此步骤使用匹配的 ARM64 Node，从已有依赖图挑选 [开源发行清单](../distribution/open-source-edition.json) 的 10 个引擎，不调用安装器或模型；输出目录必须不存在。

以该输出作为 `scripts/package-bundle.mjs --prepared` 输入，会额外打包完整源码归档、公司 Chat 配置、交接 Skill 和 HarnessHub/控制台开发依赖。入口与内网合并流程见 [公司离线交接](offline-company.md)。固定源码来自 [源码制备工具](../scripts/vendor-engine-sources.mjs)，源码与运行程序的用途分别记录。

引擎注册可通过 `acp.initializeTimeoutMs` 设置 1–60000 ms 的显式初始化预算；OpenClaw 发布模板使用 60000。协议 probe 接收此值，未配置时仍为 10000 ms；实际 Worker 从发送 Run 到收到 `engine.capabilities` 事件持有同一预算，超时报告 `ACP_INITIALIZE_TIMEOUT` 并关闭所属进程树。该预算不替代 Run 总期限，且在初始化完成后不限制 prompt 时长。

## CLI 与控制台配置

发行 CLI 的 `configure` 和 `tools use/unuse` 修改 `state/settings.json`，控制台的引擎编辑保存在 SQLite 覆盖层。已有控制台覆盖会优先于文件；CLI 检测到会隐藏本次修改的覆盖时明确失败，保留原设置和历史。此时在控制台编辑对应引擎，或使用新解压目录建立独立评测状态。更改发行配置后重启服务，新 Session 才使用新配置。
