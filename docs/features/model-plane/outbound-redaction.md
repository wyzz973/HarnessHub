# 出站脱敏

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（稳定的占位符、JSON 中标识与 data URL 保持原样、流式参数中被切开的占位符、秘密不到达上游而工具参数拿回原值、Anthropic 直通往返、超过时间预算只让该请求失败）；core 与守护进程测试（会无界回溯的规则被拒绝、旧设置文件中的这类规则启动时不生效）；经正式守护进程的集成测试（管理令牌与 provider 凭据不发往上游、经备份与同步来的危险规则被拒绝、关闭脱敏的提示）；macOS arm64。只用回环假上游；Windows 未验证 |
| 对照 Magpie | 有意不同：只替换已知的秘密，只在工具调用参数中还原；Magpie 还按模式识别 JWT、密码与个人信息（[对照表](../../magpie-parity.md#gateway-and-protocols)） |
| 权威文档 | [出站脱敏](../../gateway-features.md#出站脱敏)、[ADR 0027](../../decisions/0027-gateway-features.md) |

## 用途

Agent 的提示词、工具结果或历史中可能出现 HarnessHub 自己的秘密（Gateway Key、provider 凭据、订阅令牌、管理令牌）或用户登记的敏感值。网关在请求发往上游之前把它们换成占位符，厂商看不到原值；模型在工具调用参数中写回占位符时网关还原，工具照常能用。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 网关功能 → 出站脱敏（开关，关闭前确认；规则的正则表达式与忽略大小写，守护进程拒绝的原因显示在栏下） |
| 命令行 | `hh gateway features`、`hh gateway redaction on\|off`、`hh gateway redaction rule add NAME PATTERN [--ignore-case]`、`hh gateway redaction rule remove NAME` |
| HTTP | `GET /api/v1/gateway/features`、`PUT /api/v1/gateway/features/redaction`（`enabled`；`rules` 整体替换，至多 64 条，`flags` 只能为 `i`） |

## 已实现的能力

- 缺省开启；设置保存在 `<dataDir>/gateway-features.json`（0600，原子替换），网关对每个请求读取当前值；文件不是有效设置时守护进程以 `GATEWAY_FEATURES_INVALID` 拒绝启动，不会因为手工改错而悄悄关闭脱敏。
- 已知的秘密：按签发格式识别的 Gateway Key；本进程解析过的每个 provider 凭据与订阅令牌（至少 8 个字符的精确值）；守护进程的管理令牌；用户登记的规则（JavaScript 正则表达式，有分组时第 1 组是值，种类为规则名）。
- 占位符 `{{HH_<种类>_<8 位 base32>}}` 是值在本进程随机密钥下的 HMAC：同一个值在每个请求中得到同一个占位符，对话历史逐轮一致，上游的提示缓存不受影响；值只在内存中保存。
- 范围是出站请求体中的每个字符串（消息、system、工具结果、历史中的工具调用参数），翻译与直通相同，也包括 `count_tokens` 与 Codex 透传；标识、模型名、签名、加密内容、`data:` URL 与 base64 保持原样；直通请求只在确有替换时重新序列化。
- 只在答复的工具调用参数中还原（Chat 的 `tool_calls`、Responses 的函数与自定义工具调用、Anthropic 的 `tool_use` 与 `input_json_delta`、Gemini 的 `functionCall.args`），流式参数中被切开的占位符暂扣到同一调用的下一个片段；写给人看的文本保留占位符。
- 联网搜索的查询与图像请求的提示词同样先脱敏；OTLP 内容导出总是用同一个脱敏器遮蔽，与这个开关无关。
- 用户规则在每个入口（接口、命令、恢复备份、同步、读取设置文件）经保守的静态检查，拒绝反向引用、嵌套重复与重叠的无界重复；一个请求的脱敏总时长超过 `gateway.limits.redactionBudgetMs`（默认 1000 ms）时该请求以 503 `redaction_timeout` 失败、不发往上游；更早写下的不合规则在启动时不生效并记日志 `gateway.features_dropped`。
- 账本的 `patches[]` 只记 `redact:<个数>`，从不记值。
- 开关与规则随备份与同步带走；恢复或同步会关闭本机脱敏时以 `redaction.turnsOff`、`notice.redactionOff` 提示，服务器的设置不比本机新时不关闭（`notice.redactionOffHeld`）。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/redaction.ts](../../../packages/gateway/src/redaction.ts)、[core/regex-safety.ts](../../../packages/core/src/regex-safety.ts)、[core/gateway-features.ts](../../../packages/core/src/gateway-features.ts)、[daemon/gateway-features.ts](../../../packages/daemon/src/gateway-features.ts)、[daemon/gateway-features-routes.ts](../../../packages/daemon/src/http/gateway-features-routes.ts)、[console/gateway-features-page.tsx](../../../packages/console/components/gateway-features-page.tsx) |
| 测试 | [shared-gateway-redaction](../../../packages/gateway/test/shared-gateway-redaction.test.ts)、[core gateway-features](../../../packages/core/test/gateway-features.test.ts)、[daemon gateway-features](../../../packages/daemon/test/gateway-features.test.ts)；集成 [gateway-features](../../../tests/integration/gateway-features.test.ts)、[backup-sync-security](../../../tests/integration/backup-sync-security.test.ts)、[backup-features](../../../tests/integration/backup-features.test.ts) |
| 决策 | [ADR 0027 网关的脱敏、视觉兜底、搜索模拟与图像端点](../../decisions/0027-gateway-features.md)（含 2026-10-05 第二轮安全审查 G 组修订） |

## 已知限制与未验证

- 不做通用的“像密钥”的模式识别：JWT、私钥、密码与个人信息只有用户自己登记规则才会被替换。
- provider 凭据与订阅令牌只有在本进程解析过之后才能识别（网关在上游调用、`count_tokens` 与图像请求解析凭据时登记它）；守护进程启动后，某个凭据第一次被使用之前，请求中出现的它的值不会被替换。内存中至多记住 10000 个精确值与 50000 个占位符，超过时丢弃最早的一半（[redaction.ts](../../../packages/gateway/src/redaction.ts) 的 `MAX_KNOWN`、`MAX_PLACEHOLDERS`）。
- 静态检查偏保守，`(?:-[0-9]+)*` 这类其实无歧义的写法也被拒绝（可改用字符类）；时间预算只在字符串与规则之间检查，单次匹配不能被打断。
- 模型若把占位符写进给人看的文字，用户看到的是占位符，不会还原。
- 只用回环假上游验证；真实厂商、Windows 未验证。

## 优化候选

- **现状**：凭据要等第一次被解析后才能识别。**方向**：守护进程启动时（以及新增、轮换凭据时）预先把已配置的凭据值登记进脱敏器。**依据**：[出站脱敏](../../gateway-features.md#出站脱敏)中“解析之后的请求才能识别”的观察。
- **现状**：规则安全靠保守的静态检查，合法写法也会被拒绝。**方向**：评估线性时间的正则引擎（RE2 一类或 V8 的实验引擎），放宽静态检查。**依据**：[ADR 0027 修订](../../decisions/0027-gateway-features.md#修订2026-10-05第二轮安全审查-g-组)中考虑过的替代方案。
- **现状**：常见的密钥形态需要用户自己写规则。**方向**：提供默认关闭、可逐条打开的内置规则（例如私钥块、JWT），保持“缺省只替换已知秘密”的决定。**依据**：对照表 Outbound redaction 行有意不同；ADR 0027 的替代方案说明了不默认启用的原因。
