# 单可执行文件（SEA）可行性验证

状态：验证记录，2026-10-02，对应 TODO 中的 OSS-008 与 [ADR-P01](adr-drafts.md#adr-p01-语言与运行时)。macOS arm64 为本机实测；五个平台的构建、测量与端到端检查由工作流 [sea-spike.yml](../../../.github/workflows/sea-spike.yml) 在 CI 上完成（PR #17，运行 36970981208，每组 10 次，结果见第 5.5 节）。本文记录的是可行性原型，不是发布流水线；发布要求仍以 [10 第 4.3 节](10-engineering.md#43-发布流水线) 与 [第 5 节](10-engineering.md#5-发布工程) 为准。

## 1. 结论

1. 可行。Node 24.20.0 的 SEA 能用同一个二进制承载 Gateway、Session Worker 与我们自己作为子进程启动的脚本：二进制按 argv 选择角色，`fork()` 与 `spawn(process.execPath)` 重新执行自身。macOS arm64 上 9 项端到端检查全部通过，其中包括经 Session 模型网关对脚本化 Chat Completions 上游的一次鉴权流式调用，以及 Gateway 被 SIGKILL 后的崩溃恢复。
2. 体积：macOS arm64 二进制 125,610,416 字节（119.8 MiB），低于 ADR-P01 的 150 MB 条件，但高于 ADR 中“约 90–110 MB”的估计；其中 Node 运行时占 96%。gzip -9 后 40,542,461 字节。
3. 冷启动：从启动进程到 `ready` 行，每次使用新的数据目录，20 次的 p95 为 166.9 ms（首次运行，含解包）与 162.6 ms（已解包），远低于 1.5 s；同机 `node dist/src/main.js` 的 p95 为 196.2 ms。
4. CI 五个平台：构建与端到端检查全部通过；体积 98–131 MB，全部低于 150 MB；冷启动在每个平台都快于同机的 `node dist/src/main.js`。已解包后的 p95 在 macOS arm64、Linux x64/arm64 与 Windows x64 上为 376–721 ms；macOS x64 runner 上为 1838 ms，超过 1.5 s，但同机 node 基线也是 2310 ms；Windows 首次运行（含解包）的 p95 为 4224 ms。
5. 对 ADR-P01 的建议：保持 SEA 为主要分发形式，不因这两项改用其他语言——它们来自 runner 本身的速度与首次解包，不来自 SEA 机制；但这两项尚不能算作“在条件之内”：macOS x64 需在真实硬件上复测，Windows 首次运行需要查明耗时来源（推测是 Defender 扫描新写入的可执行文件）并设法消除或改为安装时解包。第 7 节列出进入 M1 前必须解决的事项。

## 2. Node 24.20.0 的 SEA 能力

以下均在本机 Node 24.20.0（darwin-arm64）上用最小样例或本原型实测。

| 项目 | 结果 |
|---|---|
| 生成方式 | `node --experimental-sea-config` 生成 blob，再用 postject 注入 Node 可执行文件的副本；`node --help` 中没有 `--build-sea` |
| main 格式 | 只能是 CommonJS 脚本；二进制中没有 `mainFormat` 一类的配置字段，可用字段包括 `useCodeCache`、`useSnapshot`、`execArgvExtension`、`disableExperimentalSEAWarning` 与 `assets` |
| argv | `process.argv[1]` 重复启动时的 argv0，调用方参数从 `argv[2]` 开始；`__filename` 等于 `process.execPath` |
| 模块加载 | main 中的 `require()` 只能加载内置模块；`import()` 能动态导入磁盘上的文件 URL；`module.createRequire()` 能加载磁盘上的 CommonJS 与 ESM；`Module.runMain()` 能像 `node <file>` 一样运行脚本，`require.main` 指向该脚本 |
| 子进程 | `fork()` 与 `spawn(process.execPath, …)` 运行的仍是同一个 SEA main，IPC 通道可用；操作系统看到的命令行是 `<可执行文件> <参数…>`，没有重复的 argv0 |
| 内置能力 | `node:sqlite` 可用；`node:sea` 的 `getAsset()` 读取嵌入的资源 |
| 代码缓存 | `useCodeCache` 使 blob 增加约 0.59 MB；同机关闭代码缓存测 10 次，p95 为 179.2 ms（首次运行）与 171.9 ms（已解包）；开启时（第 5.3 节，20 次）为 166.9 ms 与 162.6 ms，约低 9–12 ms。代码缓存与平台相关，因此每个目标都在原生 runner 上构建 |
| macOS 签名 | 注入前必须 `codesign --remove-signature`，注入后 ad-hoc 签名（`codesign --sign -`）即可在本机运行 |

## 3. 原型做法

实现位于 `tools/sea/`：[build.mjs](../../../tools/sea/build.mjs) 构建，[entry.mjs](../../../tools/sea/entry.mjs) 是 SEA 的 main，[measure.mjs](../../../tools/sea/measure.mjs) 测量并运行端到端检查。

**打包**：esbuild 把 `entry.mjs` 与 Gateway、Worker、command MCP、引擎启动器打成一个 CommonJS 脚本（target node24，不压缩，不带 source map）。各角色通过动态 `import()` 引入，esbuild 把它们包成惰性初始化的模块，所以一个进程只执行自己角色的模块顶层代码。

**`import.meta.url` 改写**：现有代码用 `new URL("…", import.meta.url)` 定位 Worker 入口、引擎启动器、command MCP、原生辅助程序、Pi 扩展与 `build-info.json`。打包后所有模块合并为一个文件，这些相对路径会失效。构建插件把每个模块中的 `import.meta.url` 替换为“解包根目录下、与该模块在仓库中相同的相对位置”。Gateway 与 Worker 依赖图中共有 15 处被改写（自有代码 13 处，acpx 2 处），源码无需改动；构建对任何残留的 `import.meta` 直接失败。

**角色分派**：

| argv | 运行内容 |
|---|---|
| `harnesshub serve [Gateway 参数]` | Gateway（`packages/daemon/dist/src/main.js` 的命令行入口） |
| `harnesshub version [--json]` | 输出构建身份 |
| `harnesshub <根目录>/packages/daemon/dist/src/worker/main.js …` | Session Worker；由 `fork()` 产生 |
| `harnesshub <根目录>/scripts/launch-engine.mjs …` | 可移植引擎启动器 |
| `harnesshub <根目录>/packages/agents/dist/src/tool-command/command-mcp.js …` | 工具包的 command MCP 服务器 |
| `harnesshub <其他 .js/.mjs/.cjs 文件> …` | node-compat：用 `Module.runMain()` 像 `node <文件>` 一样运行 |

子进程从自身的角色路径推出根目录，只接受标记文件中构建号与自身一致的根目录。这样即使 Worker 的 HOME 被改成 Session 私有目录，也能找到与 Gateway 相同的文件。

**解包根目录**：其他程序必须从磁盘读取的文件（构建身份、原生辅助程序、Pi 扩展）作为 SEA 资源嵌入，按构建写入每个用户的缓存目录：macOS 为 `~/Library/Caches/HarnessHub/sea/<构建号>`，Linux 为 `$XDG_CACHE_HOME/harnesshub/sea/<构建号>`（缺省 `~/.cache`），Windows 为 `%LOCALAPPDATA%\HarnessHub\sea\<构建号>`。角色入口位置写入占位文件，因为工具包绑定会检查 command MCP 入口是普通文件；占位文件被其他程序直接执行时抛错。用户命令每次启动都按 SHA-256 校验并修复这些文件，原子写入（临时文件加改名），目录权限 0700 且必须属于当前用户。`HARNESSHUB_SEA_ROOT` 可以覆盖根目录，只用于测量。构建号是 bundle 与全部资源的 SHA-256 前 16 位。原生辅助程序只从 `dist/native` 与各包的 `dist/native` 嵌入 `build.mjs` 中 `NATIVE_HELPERS` 列出的文件，这些目录中的其他文件（例如早先构建留下的旧辅助程序）会使构建失败；`build.json` 记录每个嵌入资源的 SHA-256，`measure.mjs` 的 `asset.secret-helper` 检查当前平台的密钥辅助程序解包后与记录一致（只读文件，不访问密钥库；Linux 没有该辅助程序，检查注明原因后跳过）。

**构建身份**：SEA 内嵌的 `build-info.json` 与 `packages/daemon/dist/build-info.json` 相同，只把 `installMethod` 改为 `sea`。`harnesshub version --json` 输出它，端到端检查逐字段与构建时写入的文件比对。

## 4. 改动

| 改动 | 原因与影响 |
|---|---|
| [packages/daemon/src/main.ts](../../../packages/daemon/src/main.ts) 的命令行块移入 `runFromCommandLine()`，以 `void` 调用 | Gateway 与 Worker 依赖图中唯一的顶层 await；CommonJS 不能包含顶层 await。拒绝仍不被处理，启动失败时照旧打印错误并以退出码 1 结束（已用 `--port abc` 核对）；非 SEA 行为不变，由 `pnpm check` 中从 `packages/daemon/dist/src/main.js` 启动的 CLI smoke 测试覆盖 |
| 新增开发依赖 esbuild 0.28.2 | 打包器；同一版本此前已经通过 tsx 进入锁文件，没有新增包 |
| 新增开发依赖 postject 1.0.0-alpha.6（依赖 commander 9.5.0，均为 MIT） | Node SEA 文档使用的注入工具；Node 24.20 没有内置的注入命令。两者都精确固定版本 |
| 新增 `tools/sea/` 与手动工作流 | 构建、测量与端到端检查；不改变现有构建与 CI |

## 5. 实测数据

### 5.1 环境

Apple M5 Pro，macOS 26.6.2，Node 24.20.0，esbuild 0.28.2；提交 `61b31fc`，构建时工作区干净（`dirty: false`），构建号 `3d4803a4b3c9a779`；2026-10-02。

### 5.2 体积

| 组成 | 字节 | 占比 |
|---|---|---|
| Node 24.20.0 运行时（去掉官方签名后） | 120,947,272 | 96.3% |
| SEA blob 合计 | 4,628,443 | 3.7% |
| 其中 JavaScript bundle | 3,933,546 | |
| 其中 V8 代码缓存与 blob 头（差值） | 约 591,000 | |
| 其中嵌入资源：钥匙串辅助程序 98,048、Pi 扩展 5,438、构建身份 353、角色占位 287 | 104,126 | |
| ad-hoc 签名与对齐（差值） | 34,701 | |
| **二进制合计** | **125,610,416**（119.8 MiB） | |
| gzip -9 后 | 40,542,461 | |

bundle 的输入共 3,937 KiB：自有代码 923 KiB（drivers 316、tool-packages 118、gateway 91、application 75、engine 70，其余各模块均小于 50），依赖 3,014 KiB、57 个包（zod 790、acpx 319、yaml 281、fastify 277、ajv 270、ACP SDK 230、fast-uri 120）。zod 是 ACP SDK 的对等依赖。即使把 bundle 缩小一半，二进制也只减少约 1.5%；体积几乎完全由 Node 运行时决定。

### 5.3 冷启动

测量从启动进程到 stdout 出现 `ready` 行的时间，命令为 `serve --demo --port 0`，每次使用新的数据目录与工作区。每组先做一次不计入的预热启动，p50/p95 按最近秩计算。

| 组 | n | p50 ms | p95 ms | 最小 | 最大 | 预热 |
|---|---|---|---|---|---|---|
| SEA，首次运行（每次新的解包根目录） | 20 | 161.2 | 166.9 | 152.7 | 168.1 | 153.9 |
| SEA，已解包 | 20 | 158.5 | 162.6 | 151.1 | 164.7 | 154.8 |
| `node dist/src/main.js` | 20 | 193.1 | 196.2 | 191.7 | 197.6 | 193.1 |

解包 8 个文件约 2–3 ms。SEA 比直接运行 `dist/` 快约 30 ms；推测原因是单文件加代码缓存省去了逐个解析与读取数百个模块文件，未单独拆分验证。可执行文件刚构建完，处于页缓存中；重启后的真正冷启动没有测量。

### 5.4 端到端检查（macOS arm64）

| 检查 | 结果 | 证据 |
|---|---|---|
| `version.build-identity` | 通过 | 与 `dist/build-info.json` 逐字段一致（`installMethod` 为 `sea`），提交 `61b31fc`，`dirty: false` |
| `serve.ready` | 通过 | 155.9 ms，默认引擎 `fake` |
| `role.launch-engine` | 通过 | 引擎启动器作为 SEA 角色运行，把 `HH_SEA_LAUNCH=launched` 传给子命令 |
| `role.command-mcp` | 通过 | command MCP 作为 SEA 角色运行，完成 initialize 并列出 `cli_sea_echo` |
| `demo.run` | 通过 | 假引擎 Run `completed`，清理 `confirmed`；Worker 由 SEA 重新执行自身产生，70 ms 后 ready |
| `gateway.call` | 通过 | ACP 夹具（本机 Node 运行的 `model-gateway-peer`）调用 Session 模型网关；上游收到 1 次 `POST /v1/chat/completions`，HTTP 200、Key 正确；Gateway 日志有 1 条 `model.call`（`ok: true`）；Run 输出 `OK` |
| `gateway.call.node-compat` | 通过 | 同一夹具改由 SEA 的 node-compat 模式运行，结果相同 |
| `recovery.after-crash` | 通过 | Run 运行中 SIGKILL Gateway，重启的 SEA 把 Run 标为 `interrupted`/`gateway_restarted`，清理 `confirmed`；Worker 租约记录的命令行与 `ps` 输出一致 |
| `serve.stop` | 通过 | SIGTERM 后退出码 0 |

### 5.5 CI 五个平台

GitHub 托管 runner，PR #17 的运行 36970981208（提交 e57ed2a），每组 10 次；“首次运行”每次使用新的解包根目录，“已解包”复用同一根目录，基线为同机 `node dist/src/main.js`。runner 的速度与本机不同，跨平台比较应看同机基线。

| 目标 | runner | 体积（字节） | 首次运行 p50/p95 | 已解包 p50/p95 | node 基线 p50/p95 | 端到端 |
|---|---|---|---|---|---|---|
| darwin-arm64 | macos-latest | 125,626,832 | 327 / 398 ms | 283 / 376 ms | 388 / 537 ms | 9/9 |
| darwin-x64 | macos-15-intel | 128,698,128 | 1226 / 2118 ms | 1162 / 1838 ms | 1458 / 2310 ms | 9/9 |
| linux-arm64 | ubuntu-24.04-arm | 127,274,112 | 398 / 423 ms | 398 / 406 ms | 520 / 592 ms | 9/9 |
| linux-x64 | ubuntu-latest | 131,075,264 | 452 / 456 ms | 448 / 455 ms | 576 / 581 ms | 9/9 |
| win32-x64 | windows-latest | 98,080,768 | 716 / 4224 ms | 679 / 721 ms | 803 / 861 ms | 8/8 |

macos-13 已不再向公开仓库提供（2026-10-02 查阅 GitHub 托管 runner 文档），darwin-x64 改用 macos-15-intel。Windows 上 `kill()` 直接终止进程，因此不做 `serve.stop` 检查；Worker 租约的命令行比对只适用于 POSIX，Windows 的恢复走 Job 对象。win32-arm64 是 [10 第 5 节](10-engineering.md#5-发布工程) 的产物目标之一，但不在 ADR-P01 的验证范围内，本次未覆盖。

## 6. 阻塞点与处理

| 问题 | 本次处理 | 剩余工作 |
|---|---|---|
| SEA main 只能是 CommonJS，`packages/daemon/src/main.ts` 有顶层 await | 改为不带顶层 await 的函数调用（第 4 节） | `packages/cli/src/cli.ts`（rollout 导出）同样有顶层 await，进入 SEA 前要同样处理 |
| 子进程入口、原生辅助程序与脚本按 `import.meta.url` 相对定位 | 构建时逐模块改写，资源解包到按构建区分的根目录 | 见第 7 节第 1 项 |
| 自有子进程用 `process.execPath` 启动，在 SEA 中会再次运行 SEA | 按角色路径分派；Worker 租约中的命令行仍与 `ps` 一致，崩溃恢复可以识别 | 无 |
| 第三方 Node 脚本按“随附的 Node”启动：发现的 Claude 与 Codex ACP 适配器（`[node, adapter]`）、DSH、工具包中 `launch: node` 的 MCP 与 CLI 工具 | node-compat 模式，已用 ACP 夹具验证 | `Module.runMain()` 不是文档化的公开接口；不支持 Node 命令行选项（`node -e`、`--inspect` 等），`harnesshub --version` 输出的是 HarnessHub 版本；只按扩展名识别脚本 |
| `#!/usr/bin/env node` 形式的引擎依赖 PATH 中的 `node`；[发现逻辑](../../../packages/agents/src/engine/discovery.ts) 把 `nodeExecutable` 所在目录加入 PATH，期望那里有 `node` | 未处理：SEA 旁边没有名为 `node` 的文件 | 需要一个 `node` 垫片目录（POSIX 用符号链接指向 SEA；Windows 方案待定） |
| 持久化的绝对路径：发现的引擎命令把 `<根目录>/scripts/launch-engine.mjs` 与可执行文件路径写进数据库，根目录按构建区分 | 未处理：升级后旧登记指向旧根目录，会运行占位文件并失败 | 持久化符号化的启动器引用；现状中 `dist/` 移动也有同样问题 |
| acpx 用 `import.meta.url` 找自身的 `package.json` 读版本号 | SEA 中找不到，按 acpx 自身逻辑退回未知版本 | 把 acpx 的 `package.json` 作为资源解包，或改为构建时注入版本 |
| 解包目录的信任 | 每个用户独立目录、0700、属主检查；用户命令启动时校验 SHA-256；子进程只核对标记 | 校验与执行之间仍有同用户的竞争窗口；Windows 依赖 `%LOCALAPPDATA%` 的默认 ACL，未单独设置 |
| 签名 | macOS 只做了 ad-hoc 签名；Windows 注入后 node.exe 原有的 Authenticode 签名失效 | 发布需要 Developer ID 签名与公证（含解包出的钥匙串辅助程序）及 Authenticode，签名后重跑端到端检查（[10 第 4.3 节](10-engineering.md#43-发布流水线)） |
| 控制台与其他入口 | Next.js 控制台、`tool-packages-main`、`benchmark-main`、rollout CLI 不在本次 SEA 中 | 控制台按 [ADR-P10](adr-drafts.md#adr-p10-控制台改为内嵌静态单页) 改为 Vite 静态页后作为资源内嵌 |

## 7. 对照 ADR-P01 的建议

ADR-P01 的重新评估条件是冷启动超过 1.5 s 或体积超过 150 MB。体积在五个平台都不触发（最大 131 MB，余量约 19 MB；主要风险是 Node 运行时本身继续变大，HarnessHub 的代码与依赖只占约 4%）。冷启动在本机与四个 runner 上远低于 1.5 s，且所有平台都快于同机 node 基线；超过 1.5 s 的两项是 macOS x64 runner（同机 node 基线同样超过）与 Windows 首次运行（解包后降到 721 ms）。建议保持 ADR-P01 的决定，把 ADR-P01 中的体积估计更新为实测值；OSS-008 视为“机制可行、两项数字待复核”：在真实 Intel Mac 上复测冷启动，查明并消除 Windows 首次运行的耗时，然后再勾选。

进入 M1 前需要的工作：

1. 用一个模块统一负责“自有子进程入口与磁盘资源的位置”（Worker、启动器、command MCP、原生辅助程序、Pi 扩展、构建身份），npm 包与 SEA 都经它解析，替代构建时的 `import.meta.url` 改写。
2. 持久化的引擎命令改为符号化的启动器引用，使升级与移动可执行文件不破坏已有登记。
3. 确定 node-compat 的契约：支持的调用形式、不支持的 Node 选项、`node` 垫片目录。
4. 签名与公证后重跑端到端检查；查明 Windows 首次运行 p95 4.2 s 的来源（推测 Defender 扫描新解包的可执行文件），考虑安装时解包或减少需要解包的可执行文件。
5. 升级 Node 主版本时重新验证 SEA 接口；本次只调研了 Node 24.20.0。

## 8. 复现

前置条件：Node 与 `.node-version` 一致，pnpm 10.12.3；macOS 需要 Xcode 命令行工具（`codesign`、`swiftc`）。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
node tools/sea/build.mjs
node tools/sea/measure.mjs --runs 20 --baseline
```

`build.mjs` 产出 `dist/sea/harnesshub`（Windows 为 `harnesshub.exe`）与 `dist/sea/build.json`；`measure.mjs` 写出 `dist/sea/result.json`，全部检查与启动都成功时退出码为 0、`ok` 为 `true`，任何一项失败时退出码为 1。CI 上在 Actions 中手动运行“SEA spike”，每个目标上传名为 `sea-<目标>` 的 JSON 结果。

## 9. 未验证

- 真实 Intel Mac 上的冷启动（CI 的 macos-15-intel runner 本身较慢）；Windows 首次运行耗时的来源。
- 重启后页缓存为空时的冷启动、内存占用。
- 签名与公证后的产物，以及 macOS 隔离属性下的首次运行。
- 真实引擎；工具包的 CLI 工具调用（只验证了 `tools/list`）；Pi 读取解包出的扩展；从解包位置调用钥匙串辅助程序完成密钥操作。
- Windows 上除端到端检查覆盖之外的行为：端到端检查已覆盖从解包位置运行的 Job 辅助程序（demo Run 与崩溃恢复的清理为 `confirmed`），ACL 辅助程序与 DPAPI 辅助程序未单独验证。
