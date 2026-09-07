# 协议、工具与验收

## 公司 Chat Completions

先读取公司已有配置，确定模型 ID、base URL、鉴权方式、上下文窗口和预算。模板在完整包的 `$Kit\examples\company-chat.json`，源码 checkout 中则是 `$Company\distribution\company-chat.json`；复制到公司私有配置位置，替换 `.invalid` 和所有 `REPLACE_` 占位符，协议保持 `openai-completions`。base URL 通常是网关 `/v1` 根路径，不能未经核实把完整 `/chat/completions` 路径填入。Kimi 的上下文窗口必须填写公司模型实际支持的正整数。

使用环境变量、DPAPI 或已支持的文件秘密引用；不得硬编码 API key，也不能把秘密直接写到 MCP argv、日志、公开测试证据中。保留公司额外鉴权头的实现，不绕过现有校验。

Codex 的 Responses 与 Gemini 的 Google 协议通过本地 Driver bridge 转为 Chat Completions。保留文本、函数工具调用/结果、流式结束、取消与资源清理。不能把不支持的多模态或托管工具请求静默丢弃，不能回退到外部模型服务，也不能用伪造 completed 修复失败。公司字段有差异时，在协议边界加入明确映射及脱敏的失败样例测试。

## MCP 与 Skill

按 checkout 的 `docs/tool-packages.md` 使用本地工具包；总帮助为 `& "$Kit\hub.cmd" --help`，工具子命令不支持 `--help`。在发行包自身的工作区试用时，精确参数为：

```powershell
& "$Kit\hub.cmd" tools install --source "$Kit\tools\workspace-tools"
& "$Kit\hub.cmd" tools verify --id workspace-tools --version 1.0.0
& "$Kit\hub.cmd" tools use workspace-tools 1.0.0 --engine opencode
```

`tools use` 绑定的是 `$Kit\state\workspace`，只更新该发行包状态。公司自己的工作区和网关使用 `tools bind --id workspace-tools --version 1.0.0 --engine <完整 registration.json 的绝对路径> --workspace <公司工作区绝对路径>`，需要秘密槽时加 `--bindings <私有 JSON 绝对路径>`。将返回的 `registration` 通过公司现有配置或 `PUT /v1/engines/:id` 应用；不能认为修改发行包状态自动更新了公司 Gateway。

工具文件由版本化 manifest 和 SHA-256 固定，命令指向离线包或公司批准的本地可执行文件。应用后使用新 revision、新 Session；保留 SQLite overlay 和历史 Session。

Pi、OpenClaw、Kimi 的原生 MCP 能力与限制以 `docs/native-mcp.md` 为准。Kimi 原生配置不支持安全秘密引用的字段必须明确拒绝，不能把 key 写入配置文件充数。CLI 自己读取文件不算 MCP 验证。

通过工具包分发时，manifest 固定 Skill 主文件与所有声明附件的 hash。直接配置 `SKILL.md` 仅固定主文件，附件保留原路径，需另行校验或改用版本化工具包。区分 HarnessHub 注入的指令与引擎原生 Skill 发现，不声称所有引擎实现完全相同。更新 Skill 后核对新配置 revision。

## 验收顺序

1. 先用本地合成 Chat 服务和 MCP fixture 验证正式 Gateway → Worker → 固定引擎链路，不产生外部模型费用。
2. 公司允许后运行短文本结构化结果；核对确实请求公司 Chat Completions，记录模型与入口，不记录鉴权秘密。
3. MCP 读取每次不同的随机内容，再让 Agent 生成文件；检查实际 tools/call、工具返回、文件路径/字节/hash。不能只依据 Agent 回复。
4. 权限选项使用引擎实际 optionId；原生非交互自动批准和 HarnessHub 可控审批分别报告。
5. 在流式输出中取消，验证领域状态、进程树和本地 bridge/MCP 清理；断流或退出码 0 不能代替成功证据。
6. 新 Session 使用新配置，旧历史仍能查询。执行 checkout 的相关测试与检查，记录实际通过、跳过、失败和未验证项。

交付时列出版本、源码/执行入口、run ID 和产物验证；公司真实模型未执行时明确注明。之前的 DeepSeek 证据不证明公司网关已通过。
