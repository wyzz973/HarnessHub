# 0009：Windows 便携引擎发行与工具包

- 状态：accepted
- 日期：2026-09-06
- 范围：distribution、tool-packages、发布组合入口和开发机制备

## 问题

PATH 发现只说明开发机已安装，不能保证裁判机免安装运行。复制开发者全局目录还会带入绝对路径、依赖链接和个人认证。不同引擎使用的模型协议、账号、扩展和 Windows 架构并不相同。

## 决定

开发机按固定锁文件、版本和官方二进制校验值准备运行时和引擎。发布构建物化生产依赖，拒绝越界链接、开发机路径和异构 Node addon；生成全文件 SHA-256 清单。裁判机入口只运行包内程序，模型连接使用显式配置。

distribution 拥有清单、相对模板和 settings；release-main 转为既有 EngineRegistration，复用 Gateway、Worker、Benchmark。运行状态位于 state，私有 HOME 不导入开发者账号，交付 ZIP 不包含 state。

模型配置按 adapter 映射。Copilot BYOK 由原生环境固定模型而未提供 ACP 模型目录，内部 nativeModelSelection 使 Driver 不重复请求不支持的模型控制；公共快照仍保留指定模型。Qwen 使用固定版本实际公布的 runtime model ID。Kimi ACP 1.50.0 要求 OAuth，发行配置使用官方非交互 CLI，并保留 CLI 能力限制。

工具包 manifest 记录文件大小/hash、Skill 和 MCP 入口；安装先校验复制，再发布不可变对象和登记。运行不使用 npm/pip。删除只注销登记，已选中包须先解绑。Pi/OpenClaw 不消费 ACP session MCP，因此启用时拒绝；可以使用 Skill 或原生扩展。

固定 Copilot 1.0.83 明确拒绝 ACP 客户端传入 stdio MCP，但支持启动前的原生 additional MCP 配置。配置适配器将这一类服务映射到 Session 私有文件，秘密通过子进程环境引用，HTTP/SSE 保持 ACP 传输。已有原生参数冲突时失败；不在 Gateway 添加引擎分支，不把 CLI 工具执行伪装成 MCP。实际合成 API 验证模型收到 MCP 工具定义、MCP 子进程收到正确环境值且原生配置不含秘密。

## 替代方案

npx/uvx 配方需要裁判机下载，不符合本次条件。复制全局安装与 HOME 会污染路径和账号。强制所有引擎使用同一种 wire protocol 不符合真实接口；统一的是 HarnessHub 的配置和运行契约。

## 后果与验证

包体积较大，x64/ARM64 分开构建。ARM64 中 Hermes/Kiro 使用固定 x64 组件，要求 Windows 11 仿真。协议初始化、鉴权、任务评分和工具调用分别记录。本机证据不能替代未知的裁判 OS、网络条件和比赛规范。

必须验证脱离源码目录和开发者 PATH/HOME 后的启动、UI/静态资源、fake smoke、模型任务、工具包和进程清理。清单不是软件签名或 OS 沙箱。保留第三方许可；账号限制不能通过打包消除。
