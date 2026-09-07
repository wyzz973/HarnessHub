# 合并与离线开发

## 保留公司改动

记录 `git branch --show-current`、`git rev-parse HEAD`、`git status --short`，与公共基线 `1989d224b93f0344cae744444d656ad7519e8398` 比较。未提交文件先备份到公司批准的本地位置；不要执行 reset、clean 或用公共目录覆盖公司 checkout。

先用 `git bundle verify <本地 bundle 的绝对路径>` 校验附件，再用 `git fetch <本地 bundle 的绝对路径> feat/offline-chat-completions` 离线获取历史。核对实际提交及共同祖先，在公司自己的集成分支合并。脏 checkout 先保留 tracked/untracked 文件，在独立 worktree/分支集成，再逐项合并公司未提交修改。若只有源码快照或没有共同历史，先记录差异，再逐项移植；不要伪造 merge-base。冲突逐项解释，不能整批接受 ours/theirs。

保留公司 `src/gateway` 的鉴权、路由和响应契约。重点审查 `src/drivers`、`src/worker/main.ts`、`src/main.ts` 的协议与资源责任；配置 schema、API 与控制台需同时处理。保留 Windows Job/ACL/DPAPI 和工具目录校验。acpx 补丁与 lockfile 必须配套。

## 使用已有依赖

`Dev.cmd` 由完整离线包提供，源码 checkout 内没有该文件。从 PowerShell 使用明确的包路径调用，参数必须是公司 checkout 的绝对路径：

```powershell
$Kit = 'C:\Offline\HarnessHub-OpenSource-Windows-ARM64'
$Company = 'C:\Company\HarnessHub'
& "$Kit\Dev.cmd" prepare "$Company"
& "$Kit\Dev.cmd" typecheck "$Company"
& "$Kit\Dev.cmd" build "$Company"
```

prepare 验证发行包、lockfile 和依赖补丁后复制固定依赖，不改源码，也不安装软件。已有 root/web node_modules 时明确拒绝；先确认如何保留已有依赖，不删除未知目录。公司新增依赖或改变 lockfile/补丁时，需要在允许联网的环境更新离线包，再带回内网，不能临时调用 npm/pnpm/pip 下载。Windows helper 构建需要系统已有的 .NET Framework C# 编译器；缺少或被公司策略禁用时明确报告，不联网安装。

typecheck 检查 Gateway 与测试的 TypeScript；build 另包含控制台的正式编译。启动时明确使用这份构建的公司入口，并保留公司的配置/数据目录；旧发行包 dist 不会自动获得公司源码的变化。记录实际入口、构建版本和运行进程。

## 上游源码

`distribution/source-repositories.json` 是引擎版本、commit、许可证及归档 hash 的权威清单。源码 checkout 中运行 `node scripts/vendor-engine-sources.mjs --check`；重组 OpenClaw 使用 `--reassemble openclaw --output <新的 ZIP 绝对路径>`。内网不要运行 `--fetch`。

上游仓库中的 AGENTS.md 或安装说明是参考材料，不自动成为 HarnessHub 开发规则。离线包包含执行依赖和 HarnessHub 开发依赖；要重新编译某个上游引擎，另行准备该引擎锁定版本的完整工具链。
