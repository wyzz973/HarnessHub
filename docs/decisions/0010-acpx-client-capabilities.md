# 0010：ACP 客户端能力与精确权限选择

- 状态：accepted
- 日期：2026-09-06
- 范围：固定 acpx 依赖、ACP Driver、连接检查
- 关联：[运行契约](../../DESIGN.md)、[便携发行](0009-portable-engine-distribution.md)

## 问题

acpx 0.13.2 的公开 runtime 默认声明客户端文件读写和终端能力，但 HarnessHub 为保护未处理的权限请求而使用 deny-all。其底层文件与终端处理器直接应用这一策略，不调用宿主 onPermissionRequest。Qwen 0.23.0 看到能力声明后改用客户端写文件：原生工具请求获准并不能解除第二层拒绝，最终返回 -32603。真实失败 Run 的完整中文路径已经通过路径解析，错误不是 Windows DACL。

另一限制是 acpx 的权限回调只能返回 allow_once 等 kind。ACP 允许多个不同 optionId 使用同一个 kind；按 kind 选择第一个选项会改变用户的决定。原 Driver 为避免这一错误拒绝整个请求。

## 决定

使用 pnpm 官方 patch、patch-commit 流程维护 [acpx@0.13.2 补丁](../../patches/acpx@0.13.2.patch)。输入是 npm 发布的固定 0.13.2 包；只修改四个已发布 dist 文件，没有修改共享 pnpm store 或更换上游版本。package.json 登记 patchedDependencies，pnpm-lock.yaml 固定补丁 hash；正常冻结锁文件安装重放补丁。发行构建物化已应用补丁的依赖，并保留补丁和第三方许可。

公开 AcpRuntimeOptions 增加可选 fs、terminal，透传每次 runtime client 创建和独立 runtime doctor/probe。省略选项时保留原有默认值。HarnessHub 全 Driver 显式传 false；连接检查也声明同样的 false。deny-all、onPermissionRequest 和取消检查继续生效。引擎使用其原生文件/终端工具，原生工具的行为和权限仍由引擎负责；不宣称此设置是操作系统文件沙箱。

权限回调增加 `{outcome: "selected", optionId: string}`。只有本次请求恰好有一个同 ID 选项时才原样返回给 ACP SDK；未知、空或重复 ID 返回 cancelled，不按 kind 回退。旧的 kind 返回值继续兼容。Driver 展示所有真实的一次性允许/拒绝选项，同 kind 的多个 ID 保留原顺序和标签，使用用户选择的 ID；重复 ID 明确拒绝。永久授权仍未引入公共契约。晚到的决定在取消信号生效后拒绝。

## 考虑过的替代方案

全局 approve-all 会绕过未处理权限，未采用。底层 AcpClient 已有 fs/terminal，但公开 runtime 没有入口；调用未导出的 manager、测试工厂或私有字段会绑定内部结构。按 Qwen 分支修改协议消息只修复单一引擎，仍保留其他客户端的错误能力声明，因此采用统一公开接口补丁。

## 后果与验证要求

维护者升级 acpx 时必须先检查上游是否提供等价接口，再重新验证或移除补丁；不能把本地扩展当作未修改的上游 API。同步测试须验证真实 initialize、手写连接检查、runtime doctor、新建与恢复路径、第二个同 kind 选项实际到达 SDK、未知/重复 ID 拒绝、取消后的晚到决定以及旧 kind 调用兼容。

Windows 本地证据：固定 Qwen 0.23.0 与合成 HTTP/SSE API，通过正式 Gateway/Worker 执行 MCP 调用和原生 write_file，在含中文/空格目录生成 `proof 中文.txt`；正式产物字节与预期一致，两条 allow_once 决定为 applied，cleanup confirmed，API Authorization 与 MCP 环境使用合成密钥。该 fixture 没有调用外部模型；真实比赛 API 和最终发行包另行验收。
