# 0015：发行包预装工具包

- 状态：accepted
- 日期：2026-09-20
- 范围：比赛布局构建、两个发行入口的启动顺序、`state/` 标记文件、工具包服务、`GET /v1/tool-packs`
- 关联：[Windows 便携引擎发行与工具包](0009-portable-engine-distribution.md)、[统一模型网关与比赛交付升级](0013-unified-model-gateway.md)、[Capability Pack](../capability-packs.md#预装工具包)

## 问题

评测机离线，拿到发行包的人只应配置模型。办公类 Skill、MCP 和 CLI 需要解压后第一次启动就对所有引擎可用，不能要求先执行 `Install-Tool-Pack.cmd`。同时已有两条互相遮挡的配置路径：发行命令写 `state/settings.json`，控制台和 HTTP 接口写 Gateway 数据库中的引擎 overlay，overlay 整体覆盖 settings 中同一引擎的定义。预装如果全部走 HTTP 路径，第一次启动就会给每个引擎建立 overlay，之后 `hub.cmd configure`、`hub.cmd tools use` 和 `Install-Tool-Pack.cmd` 写入的 settings 全部失效（前两者会因控制台冲突直接拒绝）；如果只走 settings，用户在控制台保存过的引擎又看不到预装包。

## 决定

- **清单随包发布**：构建脚本把仓库 `packs/<目录>` 复制为 `tool-packs/<目录>`，构建时用导入器检查，并写 `tool-packs/preinstalled.json`（`{"schemaVersion":1,"packs":[{"directory":...}]}`）。目录名限定为小写包 id 的单个路径段，清单不可能指向 `tool-packs/` 之外。
- **settings 优先**：两个入口在读取 `state/settings.json` 之前执行入口阶段，复用 `Install-Tool-Pack.cmd` 的同一个函数（全部引擎、`replace` 语义、不兼容引擎跳过、settings 原子写入）。没有 overlay 的引擎因此不会产生 overlay，发行命令仍然有效。
- **按内容只应用一次**：导入器新增不触碰存储的 `inspectImport`，入口用它计算包内容摘要，与 `state/preinstalled-tool-packs.json` 比较。摘要相同就不做任何事，用户之后解除的绑定保持解除；摘要不同（首次启动、新发行包、用户修改了包文件）才导入并绑定。只有没有引擎失败时才推进标记，失败的下次启动重试。不采用“每次启动都 importLocal”的原因：它会把用户已注销的包重新登记，并且每次启动都复制一遍包内容。
- **overlay 只补缺口**：Gateway 在建立引擎目录之后、开始监听之前执行第二阶段，仅对标记中记为 `applied`、但当前登记里没有该版本的引擎经工具包服务的 `ensure` 绑定；已带有该版本的引擎跳过，不发布新 revision。每个数据目录对每个摘要只协调一次（`<dataDir>/preinstalled-tool-packs.ensured.json`），因为 overlay 属于数据目录，而比赛模式与产品模式使用不同的数据目录、共享同一份 settings。只在摘要变化的那次启动协调，才能同时满足“控制台保存过的引擎也拿到预装包”和“用户解除后不再被绑回”。
- **永不阻止启动**：清单、标记、包内容或个别引擎的任何问题都转为结果记录：启动窗口一行说明，Gateway 日志 `toolpack.preinstall`（入口阶段结果经标记文件的 `lastRun` 传给 Gateway，两种模式一致）。标记或协调记录不可读时不猜测、不改动 settings。
- **开关**：`HARNESSHUB_PREINSTALL_TOOL_PACKS` 只接受 `0`/`1`，其他值在改动 `state/` 之前拒绝启动，与日志级别、Run 期限等开关一致。
- **可见性**：`GET /v1/tool-packs` 对标记中记录的版本返回 `preinstalled:true`，控制台据此显示标记；标记不可读只是不带标记，不影响列表。

## 后果

第一次启动多一次包内容 hash 与导入（办公包数 MB，实测毫秒到百毫秒级），之后每次启动只读包内容算摘要并重写一次很小的标记文件。预装包与手动安装的包共用存储与绑定规则，没有第二套登记。已知限制：两个入口同时首次启动会竞争包存储锁，失败的一方记为 `failed` 并在下次启动重试；产品模式的 Windows 实机链路（`hub.cmd start` 子进程接收 `--preinstalled-tool-packs`）只有跨平台接缝测试，尚无 Windows 证据。
