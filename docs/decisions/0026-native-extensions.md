# ADR-026：原生扩展的只读视图与技能调用

状态：accepted，2026-10-11。依据[ADR-020](0020-complete-native-harness-capabilities.md)。用户要求按各 Harness 实际能力接出 skills、MCP 与插件，沿用本机原安装与配置。

## 背景

- Codex app-server 提供 `skills/list`、`mcpServerStatus/list`、`plugin/installed`，并以 `UserInput.skill {name, path}` 调用技能；本机真实列表为 173 个技能、14 个 MCP 服务器、46 个已安装插件。工作区里的 `.agents/skills`、`.codex/skills` 会作为 repo 技能加载。
- Pi 的 `get_commands` 带来源：技能以 `skill:名称` 出现，扩展命令带来源文件；Pi 没有自己的 MCP。项目技能只在受信任的项目中加载。
- ACP 没有列出技能、MCP 或插件的方法；Claude、OpenCode 的技能和 MCP 提示已经出现在原生命令目录中。
- 读取 MCP 状态会联系各 MCP 服务器，耗时不宜并入每次模型目录读取。

## 决定

1. **只读列表。** `HarnessControl.extensions()` 返回原接口报告的技能、MCP 服务器（运行状态、认证、工具数、是否读取失败）与插件或扩展，每类最多 512 项并标记截断。Codex 与 Pi 实现；ACP 接口返回 null，界面说明其技能在命令目录中。Hub 不安装、不启停、不登录 MCP，也不改变它们的配置。
2. **按需读取。** `GET /api/v1/harnesses/:id/extensions?controlId=&workspace=` 用与模型目录相同的短期原生探针读取，不缓存；界面在打开“原生扩展”面板时读取，可手动刷新。
3. **技能调用走命令。** Codex 启用的技能进入命令目录（`skill:名称`），以 Codex 自己的 skill 输入发送，剩余文本作为同一条输入；停用或不存在的技能不调用，原文作为普通输入。旧版 Codex 没有 `skills/list` 时没有技能而不报错。Pi 的技能本来就是原生命令。面板中的技能可一键填入命令。

## 影响

- 统一界面可以看到并使用本机技能，MCP 与插件状态可见；管理操作仍在原程序中。
- 未做：OpenClaw 的 Gateway 技能与工具目录（需直连 Gateway）、MCP 登录与重载、插件安装。

## 否决方案

- 把扩展并入模型目录：MCP 状态读取会拖慢每次模型选择。
- 由 Hub 写技能或 MCP 配置：会修改用户的全局配置。

## 验收

见[原生扩展验收](../verification/native-extensions-2026-10-11.md)。
