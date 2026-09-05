# ADR 0001：开发与文档治理

Status: accepted

日期：2026-09-05。决定已采用；自动化覆盖以 [检查要求](../testing.md#检查入口与接入顺序)的实际接入情况为准，不代表业务功能已完成。

## 问题

HarnessHub 将同时管理多个外部 Harness、持久任务状态、跨进程取消和 Windows 资源。接口名称相同并不能保证生命周期相同；文档、测试、配置与运行状态不一致容易造成静默丢历史、重复执行和错误完成声明。需要能指导后续人员及 Agent 的持续规则。

## 决定

采用短根 AGENTS + 单一设计基线 + 分工明确的开发/测试/文档规范 + 少量 ADR + 验收记录。根 [TODO.md](../../TODO.md)拥有开发任务、依赖与进度，任务完成引用验收证据，不把设计采纳当作实现完成。所有非机械变更有问题、最终行为与验证说明；重要接口和取舍写 ADR，常规修复无需新建 ADR。

规范同时明确所有权、失败语义和如何验证。先落地零依赖文档检查；业务代码出现时接入类型、模块依赖、状态机、真实 DB/IPC、发行入口及 Windows 检查。人工规则与可执行检查分别标明，不把检查计划写成已具备能力。

决策状态与实现证据独立。前者说明为什么这样做，后者说明在哪个版本、平台和任务上实际成立。外部仓库的规则先按本项目职责裁剪，不成为隐式指令或新的审批流程。

## 考虑过的替代方案

**只写一份长 AGENTS。** 信息容易重复且挤占每次任务上下文，命令与规则也更难维护，因此根文件只保留短规则并链接所属说明。

**完整照搬 DSH 治理设施。** DSH 已有多包、双语、Cordis、Typert 和大型 CI 需求；HarnessHub 单包起步，暂不采用双语 sidecar、六类 Agent Note 生命周期目录、全仓每文件 100% 覆盖、框架专用 catalog 与检查调度器。

**先仅写规范、以后再加全部自动化。** 完全依赖人工容易让新规范失去反馈，所以本阶段加入能实际运行的文档检查。运行架构检查依赖源码与工具链，按首个相关模块接入，不生成空壳成功命令。

## 后果

契约、持久化和权限变化需要多更新所属文档及证据，但无需为小修复制造流程文件。真实引擎和 Windows 证据有环境成本；不可运行时必须保留未验证项，而不是用 Mock 或其他平台宣称通过。

轻量文档检查覆盖有限，锚点、类型示例和外部链接仍需复核。规模增长到需要 Markdown AST、生成 OpenAPI、API 文档或并行 CI 时，采用成熟工具并更新此决定的适用事实。

## 验证要求

根入口能定位设计和三类规范；新检查有有效/无效样例及非零失败出口；本项目文档通过现有检查；规范没有虚构可运行 pnpm/CI 命令。首个业务骨架必须补齐检查计划中的对应项目。

## DSH 参考映射

阅读日期：2026-09-05。参考仓库远端 HEAD 已核实为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`。以下是设计来源，不是 HarnessHub 自动执行的命令。

| 借鉴内容 | 固定源码依据 | HarnessHub 采用方式 |
|---|---|---|
| 常驻规则与严格边界 | [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/AGENTS.md) | 短入口、类型边界、相关检查和准确完成报告 |
| 生命周期与事实归因 | [defensive-patterns.md](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/defensive-patterns.md) | 区分超时/退出/清理，等待资源真正退出 |
| 真实组合与提交后发布 | [packages/AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/AGENTS.md) | 正式 Gateway/Worker + 真 DB/IPC，不移植 Cordis 专用规则 |
| 文档分层与单一事实源 | [docs/AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/AGENTS.md) | 中文单包结构，代码和所属文档同步 |
| 决定与替代方案 | [Agent Notes](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/.agents/notes/README.md) | 重要决定使用 ADR，accepted 与验证分开 |
| 检查对应改动 | [testing.md](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/testing.md)、[lefthook.yml](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/lefthook.yml) | 本地快速相关检查，CI 承担完整与平台验证 |
| 自动化检查落实 | [检查组合](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/scripts/run-gates.ts)、[链接校验](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/scripts/verify-md-links.ts)、[CI](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/.github/workflows/ci.yml) | 校验实际配置行为，新增检查配拒绝样例，跳过不能算通过 |
