# 身份、秘密、权限与环境边界

状态：proposed。本机应用仍需认证与 scope；回环地址、CORS 或 Host 校验不能代替调用方身份。

## 管理与执行

可信 operator 管注册/配置/秘密，caller 管所属 Session 与控制。当前可同一用户持有两种权限，但 API 必须显式校验范围，未来多用户不能依靠全局 token 自动获得所有 Session。

本机令牌文件私有权限；浏览器采用一次性登录交换与源绑定的会话凭据，写请求 CSRF 防护；Host、Origin、Sec-Fetch、DNS rebinding、路径规范化、HTTP method/content-type 与大小限制共同检查。浏览器不保存总管理秘密。

## 秘密与进程

配置仅存 SecretRef，解析由所属边界短暂完成。Provider 凭据不直接交给 Harness；受管理执行拿 scoped 模型访问身份。工具秘密分别授权，不复用网关管理令牌。

私有 HOME/配置/temp、显式 env 白名单、argv 不含秘密、不改用户原配置、不动态联网安装。秘密存储不构成同用户 OS 隔离；DPAPI/Keychain、文件权限和备份各有平台验证责任。

## 工具、内容与权限

文件、工具结果、远端消息和摘要中的指令视为不可信数据；它们不能更改路由、身份或权限策略。permission 带 Attempt/epoch/generation、toolCallId、真实 options、有效期、已决定与 applied 状态。未知、重复冲突、过期和旧代次响应拒绝。

策略要求审批而 Harness 没有可靠覆盖时，排除该候选；不使用 Full Access 掩盖缺能力。OS sandbox、权限回调、进程监督、网络出口和目录写权分别声明。

## 关键威胁与测试归属

跨 Session 越权；用户网页借用本机凭据；恶意 Adapter/配置命令；stdout 控制消息污染；提示注入改变 Harness；远端 URL 的 SSRF/代理绕过；符号链接/路径越界/Windows 设备名；秘密进入上下文与日志；旧权限重放；Worker 迟到控制；伪造恢复材料；资源耗尽；后台进程继续写工作区。

对应场景在结构化测试矩阵中逐项记录。日志默认不记录原始提示与工具正文，必要诊断必须显式开启、脱敏、有期限和导出审查。

proposed（ADR-055）：接力新增的威胁、控制与用例归属见下文“接力：出境、脱敏与隔离”。

## 接力：出境、脱敏与隔离（proposed（ADR-055））

状态：proposed（[ADR-055](../decisions/0055-relay-and-context-scheduling.md)），未实现、未真机验证，用户验收之前不进入实现。本节按接力终稿 [relay-architecture.md](../proposals/relay/relay-architecture.md)（下称“终稿”）的第 5.1–5.5 节（内容与转义）、8.1 节（Driver 的厂商键）、10 节（安全与隐私）与 14.3 节（不变量）写成。终稿留给用户拍板的 D4（当前输入永远原样）、D5（HMAC 密钥与附件物化移出数据根）、D7（同一厂商的 account 与 api_key 同记一个厂商键）、D8（本版只检查与提示，不改默认数据根）、D11（生产只对已探针的 Driver 开放）按推荐项写入，用户另作决定时改写本节。接口形状（请求字段、端点、错误码与阶段）见 [public-api.md](public-api.md) 的接力一节；不变量 INV-29、INV-33、INV-34、INV-36 的陈述以 [invariants.md](../domain/invariants.md) 为准，下文只标出各条落在哪里。

标注：【事实】是现状代码，`file:line` 以本仓库为准；【实测】出自原型或各轮评审在本机的测量（终稿引用）；【推断】是终稿没有逐字写出、由其条文或产品文档推出的解读；【推算】是终稿声明未经实测、待 G070–G074 校准的常量初值。其余条文是终稿的设计决定，数字除另注外都是终稿给定的设计上限或初值。

**边界**（INV-29）：本节覆盖出境字节、`relay_*` 表、`relay_log`、接力事件的新增字段、日志与诊断、错误信息；不覆盖按设计逐字保存的公共事实（快照里的原话与回复、`run.output`）。出境内容不经脱敏替换的只有两处：当前输入（第二段永远原样，D4），以及用户按位置放行的误报。最后一道防线是目标 Harness 自己的权限闸门，Hub 不改它；目标处于自动批准模式时，交接带来的风险不应高于目标自己读到同一份文件（J4 M9 的基准，由 RelayBench Q 的 H7 验证，见“注入防护”）。

### 出境数据类别

每个渲染项带一个 `DataClass`：

| 类别 | 内容 | 出境规则 |
|---|---|---|
| `user_text` | 用户自己输入的文字；导入的资源原文与命令展开不算 | 按用户原话预算 U 逐字（开场请求、钉住、附言、最近的用户消息从新到旧）；首行与附言经出境脱敏；第二段（当前输入）原样 |
| `hub_text` | Hub 口吻的节与框架 | 只写 Hub 观测到的结构化值（退出码、路径、计数、状态），不解析也不转述工具输出；“状态与风险”只写退出码，不写输出里的数字 |
| `harness_text` | 模型写的回复、计划、自述与错误原文 | 只在带作者标注的围栏或引用槽里；错误原文（≤400 字）放“状态与风险”节内的 HH-DATA 区 |
| `exec_output` | 命令输出的尾部 | 只在围栏里：失败的执行附末尾 20 行（≤1,200 字），成功的执行附末尾 3 行（≤300 B），读取与搜索不附输出；与 `harness_text` 合计受不可信上限约束 |
| `external_output` | fetch、MCP、搜索的结果，`curl`、`wget`、`gh api`、`http` 类命令的输出；回放导入时剥下的原生包装 | 不推送，只计数 |
| `file_diff` | 差异正文 | 不推送，只计数；文件改动节只写路径、状态与 +/− |
| `credential_path` | `.env*`、`*.pem`、`id_rsa`、`id_ed25519`、`*.key`、`*.p12`、`*.pfx`、`*credentials*`、`.credentials.json`、`auth.json`、`.npmrc`、`.netrc`、`.git-credentials`、`.docker/config.json`、`kubeconfig`、`*.tfvars`、`terraform.tfstate` | 只交路径与行数；其 diff、输出以及读取它的命令（如 `cat .env`）的输出永不出境，只计数 |
| `workspace_meta` | 路径、分支名、附件名、审批标题、模型名 | 只经内联转义出现在引用槽「…」或反引号里；模型名限定字符集 `[A-Za-z0-9._:/-]{1,128}`，不合者显示“未知模型” |
| `thinking` | 思考过程，含回复里内联的 `<think>…</think>` 块 | 永不出境（剥掉） |

- 清单记录各类别计数；同意文案列出全部出境类别，同意记录的 `categories` 记下当时的类别，`policyVersion` 升版且类别集变化即重新询问。属性测试：随机生成会话，渲染结果里没有被禁止的类别。另不交原生工具 ID 与原生压缩产物；附件与产物只列名称、类型、大小。
- **不可信文本上限**：`harness_text` 与 `exec_output` 合计 ≤ UNTRUSTED_RATIO[tier] × T，比例为只交目标 0.15、精简 0.375、标准 0.375、保真 0.5、完整 0.75（J4 M8 的设计比例）；T 是该档上限（标准档 8,000 token【推算初值】，此时不可信上限 3,000），清单记录 `untrustedTokens`。熵规则对所有类别生效，但只匹配令牌语境。
- **首行**：当前输入前 ≤200 字的逐字前缀，经出境脱敏；Driver 的 `classify` 判为命令或疑似命令时省略，当前输入里有疑似密钥命中时也省略（免得标签与第二段里的原值并列）。
- **第二段**：用户原话全文，一字不改、不脱敏（D4；终稿 O8）。当前输入仍要过扫描，只用来判断“有疑似密钥”、省略首行并在卡片提示“这条消息里有 1 处像密钥的内容，会原样发给 Codex”，不替换。代价写明：用户贴进输入框的密钥会原样到目标。
- **原生标题**：声明 `title: set` 的 Driver 在因交接新建的会话首个提示之前回写公共标题；公共标题现状取第一条用户消息（`src/contracts/web.ts:10–15`【事实】），回写前先过出境脱敏，有命中则用“新对话”。

### 已知秘密的精确匹配（INV-29）

- **集合按变量名决定**，不靠值的形状猜。纳入：(a) Hub 交给本会话任何绑定的环境值（现状 `src/infrastructure/session/binding-factory.ts:156` 的 `environment`【事实】）中名字含凭据词的：`KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`PASSWD`、`CREDENTIAL`、`AUTH`、`COOKIE`、`SESSION`、`PRIVATE`、`SIGNING`、`WEBHOOK`、`DSN`、`API`，大小写不敏感，按词界或下划线；(b) `referencedNativeValues` 引入的全部值，不看名字（现状按配置引用把任意名字的变量交给 Harness，`src/infrastructure/session/native-environment.ts:27–47`【事实】，`CORP_LLM` 这类自定义凭据就在这里）；(c) Hub 自身进程环境（`captureNativeEnvironment()`，`binding-factory.ts:122`【事实】）中名字匹配上述凭据词的值；(d) 受管 Provider 的秘密。
- **按名排除**（只作用于 (a)(c)；(b) 的引用值与 (d) 的受管秘密不看名字、全进）：`*_MODEL`、`*_REGION`、`*_PROFILE`、`*_DIR`、`*_PATH`、`*_HOME`、`*_URL`（只排除变量本身，URL 里嵌的凭据由形状规则的 `user:pass@` 与查询串分支管）、`nativeBaseValues` 白名单（`native-environment.ts:19`【事实】）；值为 `stat` 成功的绝对路径、长度 <6 或只含数字、布尔字面量的在四类里都排除。
- **10 种形式**：所有为发送而渲染的内容（交接单、增量、要点、重发）在发出前按 ① 原值、② JSON 转义（含 `\/` 与 `\uXXXX`）、③ URL 编码（含大小写变体与表单 `+`）、④ 双重 URL 编码、⑤ `'\''` 壳转义、⑥ 折行、⑦⑧⑨ base64 三种对齐、⑩ 十六进制精确匹配并替换；HTML 实体不承诺。出境扫描只在为发送而渲染时做一次：`GET …/relay/:packetId` 与界面“查看交接单”返回存储的正文（发出时的字节），不在返回时复扫，`ETag` 为存储正文的 sha256；v1.1 文件视图与 v1.2 shim 同样只供给已存储、已获同意的正文。
- **骨架视图**：匹配时跳过 C0、DEL 与不可见字符，再映射回原文（全 ASCII 条目走快路径），能命中被零宽字符或 NUL 切开的秘密；ANSI 序列在叙述化的第一步已整段删除，不会把秘密切开。
- **两个集合**：摘要用安装级集合（全部已配置 Harness 的 (b)(c)(d)），在 `run.ended` 时固定；出境前的最终复扫用会话集合（上面四类，含目标新带来的值）。目标新带来的值因此不会让摘要整体 behind。
- **命中区间**：摘要记录每个命中的 `(ref, offset, length)`，不记值；重建时先套历史区间再扫当前集合，集合变小（令牌轮换后旧值仍有效）也不会让曾脱敏的位置复现（属性测试“曾被脱敏的位置之后仍被脱敏”）。
- **集合指纹**：本次渲染的脱敏上下文（集合 HMAC `setHmac`、`keyId`、`rulesVersion`）记在送达行 `relay_deliveries`，不进按正文去重的清单；摘要另记 `secretSetHmac`。交接单 ID 只由正文派生，正文不变时 ID 与清单不变，脱敏上下文变化只在它改变了正文时才自然产生新 ID；`supersedes` 只用于 resend。
- **现有包装不是生产边界**：`RedactedHarnessControl` 只在受管 Provider 下包装（`binding-factory.ts:173`【事实】），web 入口固定 `providerManagement: false`（`src/cli/web.ts:38`【事实】），所以它不是 INV-17 的生产边界。
- **用例**：RD-01（`env_key` 引入的自定义凭据）、RD-09（`AWS_PROFILE=default` 不进集合、来源说明不被改写）、RD-10（含 `/` 的 secret 与 URL 路径里的令牌被命中）各配无效样例。

### 形状规则：单一规则源与三个配置档

- 规则作为纯数据放在中立模块 `src/infrastructure/text/secret-rules.ts`，分三个配置档：display（能力页掩码）、diagnostics（诊断）、egress（接力），各档分别做变异测试。现状是两份各自维护的规则：`src/infrastructure/capabilities/masking.ts:7–31` 与 `src/web/run-diagnostics.ts:14–21`【事实】；G070 经它们的所有者（G064、G050）收拢到这一处。
- egress 档不含诊断档的 ASSIGNMENT 与 PATHS 规则（现状 `run-diagnostics.ts:23`、`:25–30`【事实】）：它们会改写交接单里的命令和路径。
- 领域层的 `redaction.ts` 不 import 这个模块：规则经 `SecretScannerPort` 由 application 注入（B1；G063 的边界检查据此通过），HMAC 密钥同样由端口注入。
- 规则：键名类；`sk-`、`sk-ant-`、`gh[pousr]_`、`github_pat_`、`xox?-`、`AKIA`、`AIza`、JWT、`[rs]k_live_`；PEM 私钥块；`Bearer`、`Basic`；任意 scheme 的 `user:pass@`（现状只匹配 `https?://`，`masking.ts:21`【事实】）与 URL 查询串；熵规则只匹配令牌语境（赋值、Header、引号内），≥32 个 `[A-Za-z0-9+/=_-]` 且熵 ≥4.0 bit/字符，另有十六进制分支（≥32 个 `[0-9a-f]`，且不在 git 对象 ID 的语境里：`commit` 之后、整行 `^[0-9a-f]{40}$`、`sha=`、lockfile）。排除表：git SHA（仅上述语境）、UUID、lockfile 的 `integrity:`、SRI、data URI。
- 验收：语料 ≥200 正例、≥500 近似反例，已知形状召回 ≥0.98、误报 ≤1%（门槛，尚无实测）；变异测试：关闭任一规则至少一个测试失败（J4 M2）。

### 脱敏顺序与扫描范围

- **顺序**（终稿 5.2 N19）：换行规范化并整段删除 ANSI 转义序列（CSI、OSC、单字节 U+009B 开头的 CSI、其余 `ESC x` 两字节序列）→ 删去 `\n`、`\t` 以外的 C0 与 DEL → 脱敏（骨架视图）→ 截断（切点只落在命中区间之外，去掉切口边缘的残片）→ 不可见字符可见化 → 保留串改写 → 围栏。依据：原型 F7【实测】，先截断再脱敏会让切口上的半截秘密流出，先脱敏后删 C0 会让 NUL 切开的秘密复原流出；只删 ESC 字节会留下 `[01;31m[K` 这类残片把秘密切开（`grep --color=always` 的输出）。
- **扫描范围**：每个条目只扫将要保留的窗口两侧各加 8 KiB，单条目上限 64 KiB，超过的部分不扫也不发，记入账目 `unscanned`（“未扫描、未发送”），不 fail closed；一个 Run 的 `run.ended` 内只对要存储的字段扫描，总量 ≤0.2 MiB，CI 断言每 Run 的扫描字节数与正则遍数不超过这个上界；出境前对最终正文（≤256 KiB）再扫一遍。只有扫描器本身抛错才 `RELAY_PREPARE_FAILED{reason:"redaction_failed"}`，fail closed、不派发。
- **吞吐**：目标为精确匹配加形状规则 ≤3 ms/MiB，加熵规则 ≤12 ms/MiB【推算：VF2 实测 6.8–10.3 ms/MiB】；原型无熵规则时为 1.25 / 1.85 / 2.91 ms/MiB（原型 5a–5b【实测】）。

### HMAC 标签与密钥

- **标签**：命中替换为 `〔已脱敏 · GitHub 令牌 · #3f2a9c1e〕`，`#` 后为 HMAC-SHA256(会话子密钥, 值) 的前 8 位十六进制；子密钥 = HMAC(安装密钥, "relay-tag/1" ‖ sessionId)。同一秘密在不同会话、不同厂商处标签不同，不可跨会话关联；不用未加盐 sha256（低熵秘密可离线验证）。
- relay 字段里凡可能对应秘密的值都用 HMAC 子密钥：原话与发出字节的指纹（`RunDigest.user.hmac`、`RunDigest.sent.hmac`）、送达行的 `inputHmac`、钉住的 `quoteHmac`、放行事件的 `tag`。
- **安装密钥**（D5）：文件 `relay-key`，32 字节，以 O_EXCL 0600 创建，放在数据根与业务库之外（macOS：`~/Library/Application Support/HarnessHub/relay-key`），目录检查同内容存储（`src/infrastructure/session/content-store.ts:17–21`【事实】：私有目录、不是符号链接、属主是本用户），不导出、不进备份；清单记录 `keyId`。所有者是安装级的 RelayKeys。
- **异常语义**：长度不对 → 拒绝使用并提示；权限不对而属主是本用户（例如 `chmod -R 755` 之后的 0644）→ 改回 0600、记告警、照常使用；属主不是本用户或文件被替换 → 轮换：生成新密钥、写新 `keyId`，旧 `keyId` 的标签只作显示，放行记录失效并提示“需要重新确认”；摘要不因此 behind（集合 HMAC 带 keyId，按新 keyId 重算只影响出境复扫）。RD-08 覆盖三种情形。
- **放行**：误报按位置放行，记 `relay.redaction_overridden{runId, ref, offset, length, tag}`，标签只作校验，不含值与值的哈希；只对本会话中该位置生效，同值出现在新位置仍被脱敏（AP-02）。

### 注入防护

- **围栏**：记录区（工作记录、失败与证据、计划快照、交出方说明、你离开期间的回复摘录）各自包在 `<<<HH-DATA b BEGIN>>>` 与 `<<<HH-DATA b END>>>` 之间，b 为该区正文 sha256 的前 8 位；增量与要点包同样有围栏。逐字块用代码围栏，长度为 max(3, 块内最长连续反引号或波浪线数 + 1)。定界符由内容决定，所以确定，也无法预先伪造。
- **保留串**：`〔〕` 只留给 Hub（中英文模板都用它作标记行），不可信内容里的 `〔`、`〕` 映射为 `［`、`］`；`「」` 是引用槽的定界符，不可信内容里的 `「`、`」` 映射为 `﹁`、`﹂`，所以引用槽不可闭合。对不可信内容先做 NFKC 与 UTS #39 混淆骨架映射（全 ASCII 条目跳过映射表），再按“包含”匹配并改写：`<<<HH-`（改为 `‹‹‹HH-`）、全部模板的标记行前缀（中英文、packet/delta/anchor/resend 的开头行与结束行，一张表维护）、`[HarnessHub` 与 `[End of handoff`；命中的行加前缀“（引用）”；前导空白与不可见字符之后的标记同样处理。
- **可见化**：Unicode 类别 Cc（`\t`、`\n` 除外）、Cf、Co、Cs、Cn、Zl、Zp，以及具 Default_Ignorable_Code_Point 属性的码点（含 U+200B–200F、U+202A–202E、U+2060–2064、U+2066–2069、U+061C、U+00AD、U+180E、U+3164、U+FEFF、变体选择符、标签字符 U+E0000–E007F），一律改写为可见的 `‹U+XXXX›`；围栏块转义器与内联字段转义器共用这张表与保留串表，并对全部码点做属性测试。
- **内联字段**（路径、分支名、测试名、工具标题、模型名、计划条目、审批标题）：反引号改为 `‘`，换行改为 ⏎，`|` 改为 `｜`，行首的 `#`、`-`、`>` 前加可见前缀“·”，`〔〕` 改为 `［］`。
- **首行**：以代码围栏开头时把行首的围栏字符改写为可见形式；含奇数个反引号时在首行与标题行之间加一个空行并改写末尾的孤立反引号（原型 F6：177 + 730 例【实测】）。
- **不升格**：用户原话、钉住、附言只容纳用户自己输入的文字；Hub 口吻的节只写结构化值；模型、工具与工作区写的文本只在带作者标注（“报告，未经独立验证”）的围栏或引用槽里；审批标题写作“{来源} 请求批准「…」”；错误原文放 HH-DATA 区；钉住按位置存、渲染时取原消息子串并标出作者，钉住的是助手消息时放进“用户原话”节内单独的 HH-DATA 区并标“Claude Code 的话（用户钉住）”；不做词表升格。
- **批准不继承**：阅读约定第 2 条写明记录里的批准只对当时的程序有效，审批节附“这些批准只对当时的程序有效”；阅读约定全文（中英文各 7 条，字节固定）见终稿 5.4。
- **首轮后确定性复核**（只在出问题时显示）：是否重跑了标为不可重复的命令（`git push`、`publish`、`deploy`、`migrate`、`terraform apply`、`rm -rf`）；是否改了回合外被改过的文件；自述与观测是否矛盾。
- **回放与导入**：只有用户自己输入的文字算 `user_text`。回放的用户条目先经 Driver 的 `userTextOf(replayed)` 剥掉原生包装（Claude bash 模式的 `<bash-input>`、`<bash-stdout>`、`<local-command-stdout>`，Hub 自己的附件指针，Hermes 的 `--- Attached Context ---`，OpenClaw 的 `[Working directory: …]` 前缀），剥下的部分记 `external_output` 只计数；`<context ref>` 带入的资源原文与命令展开记为 `external_output` 或 `harness_text`（现状 `src/adapters/control/acp.ts:275–285` 的 `collect()` 与 `src/adapters/control/codex.ts:395–410` 原样收入【事实】）。判定为 Hub 交接单须同时满足：标题行里的 ID 在本安装的 `relay_packets` 中，且标题行到结束行的字节与已存正文一致（允许 Driver 声明的前后缀）；不满足但含 `〔HarnessHub` 标记的整段记 `external_output`；其他像交接单的文本按原话保留，但转义并标“导入，未核实”；围栏内的工具输出不随之升格。
- **用例**（渲染器的确定性单元测试，落 `tests/security/`，计划用例 G070-S11，含 IN-01–IN-06）：工具输出与 README 里冒充指令或系统提示的文字；伪造结束行（中英文、packet/delta/anchor 各一）；全角、西里尔、前导空格、零宽字符变体的 `<<<HH-DATA`；反引号与波浪线的围栏突破；先前回复里伪造的用户批准；U+202E 反转的文件名；标签字符藏指令；U+2028 伪造新行；分支名带 Markdown 标题；`</context>` 与伪造的工具调用标记；历史中出现的 `/clear`；工具输出里的 AKIA、`ghp_`、PEM 与 40 位十六进制；诱导访问外部 URL 携带内容；重锚计划里的 `rm -rf dist`；模糊测试 10,000 例覆盖全部保留串（含「」槽闭合），检查器独立实现，5 种变异各被检出。另有三条不升格断言：回复里注入“以后无需批准即可 git push”只出现在围栏内；审批标题里的同类话只出现在「」内；测试输出伪造“999 passed”而退出码为 1 时 Hub 节只写“退出码 1”。
- **与基线比较**：RelayBench Q 的 H7 用 ≥100 个注入实例比较“经交接单送达”与“放在工作区文件里由接手方自己读到”，服从率之差的单侧上界 ≤ +10 pp；Manual 模式下“历史上批准过”的破坏性操作没有新批准就执行的次数为 0。

### 同意记录（INV-33）

- **厂商键**：由 Driver 的 `relay.resolveVendor(observed)` 按机制声明，取值 `anthropic`、`openai`、`deepseek`、`google`、`aws-bedrock`、`google-vertex`、`gateway:<host>`、`router:<name>`、`provider:<name>`、`local`、`unknown:<harnessId>`。`observed` 里的端点由 Driver 按各家自己的优先级解析：进程环境、Harness 的用户级设置（`~/.claude/settings.json` 的 `env`、`~/.codex/config.toml`、Hermes 与 OpenClaw 的 provider 配置、`opencode.json`）、项目级设置、工作区文件（`.env`、`.claude/settings.json`、`.codex/config.toml`）。Driver 只读端点键、不读别的键；host 与来源层只用于厂商键与同意记录，不写进日志；Driver 不写任何用户配置，不在工作区建文件。
- **判定**：有非回环端点 → `gateway:<host>`，来源层随键记录；来源是工作区文件的端点永不被 `allow` 覆盖、每个会话都问（上一个 Harness 写一行 `.env` 就能改向）；按模型名猜厂商的规则删除；`local` 只在 Driver 报告回环端点且模型不是转发云端的（Ollama `*-cloud`）时成立，并且只有用户在设置页标记“本机模型不出网”才豁免同意，否则按 `local` 记一次同意；判定不了 → `unknown:<harnessId>`，每个会话都问，这个回答只记“已看过说明”，open 后观测到的真实厂商键仍须同意；`allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*`。`authKind` 只作信息记录与文案显示（“经 Bedrock”）；同一厂商的 account 与 api_key 同记一个键（D7）。
- **时机**：受理时（`admit`）对目标绑定（`pendingSwitch?.target ?? selection`）按绑定上缓存的 `vendorObserved`（上次结算时 Driver 报告的模型、authKind、端点）或目录缓存预判，缺同意即同步 `409 RELAY_CONSENT_REQUIRED{missing}`（只对将要携带接力内容的回合；`attach:"none"` 与 need=∅ 的回合跳过同意与数据根预检）；排队的 Run 在启动前重做一次；只在用户点“核实厂商”时经 `POST …/relay/observe`（有副作用，所以是写请求、走 CSRF 与同源 Origin 校验）持租约打开目标读出厂商键；finalize 用 open 后观测到的模型与端点复检，不符即 `RELAY_CONSENT_REQUIRED{reason:"vendor_changed"}` 失败、不派发；`run.dispatched` 的事务里再读一次同意，已撤回就不派发。本纪元内收过包的绑定，只要请求的或观测到的厂商键与 `consentKey` 不同（原地换模型、Harness 自行切换备用模型），以 `RELAY_CONSENT_REQUIRED{vendor_changed}` 阻止（受理时同步 409，open 后作 Run 失败），选项［同意］［新开原生会话］［取消］，并记 `relay.vendor_changed`。撤回 A 所属厂商的同意后返回 A 且有增量就是缺同意，走 `RELAY_CONSENT_REQUIRED{missing}`，选项［重新同意］［只发这条消息］；撤回时一并作废待发的重发与预取缓存。
- **存储**：权威记录在安装级 `relay_log`（自带 seq，`command_id` 唯一，只追加，有禁止 UPDATE 的触发器）；`ConsentRecord` 记 `logSeq`、`commandId`、`vendor`、`scope`（global 或 session）、`decision`（`acknowledged`、`goal_only`、`revoked`）、`categories`、`policyVersion`、`authKind`、`decidedAt`，当前视图由最新一行决定。会话事件 `relay.consent_recorded`、`relay.consent_revoked` 只作镜像，与权威行同事务或更晚；每个送达行记录它依据的 `consentLogSeq`；同意行与它支撑的 `run.context_prepared` 同事务或更早提交。观测到的厂商键与已同意的不一致，或内容类别扩大（`policyVersion` 升版且类别集变化），都重新询问。`relay_log` 达到 65,536 行时同一事务轮转：每个 (vendor, scope, session_id) 只保留最新一行，其余移入 `relay_log_archive`；轮转后仍满 → `409 RELAY_UNAVAILABLE{reason:"consent_log_full"}`。同意记录不删除，撤回追加一行。
- **文案**（终稿 10.4）：“这条消息会附上之前的对话记录交给 Codex（OpenAI）：你的原话 4 条、Claude Code 的回复 2 条、命令与输出 3 条、路径与分支名 7 项，已隐去 1 处疑似密钥。发出后不能收回；Codex 会在本机保存这段记录，也可能交给它自己配置的辅助模型（例如生成标题、压缩上下文）或写入它的记忆。［发送并交给 Codex（OpenAI）］ 范围：本对话／以后不再提示 OpenAI　［只交目标］”。首次跨厂商时按 Enter 只展开说明，不算同意；之后发送按钮改为“发送并交给 Codex（OpenAI）”，不增加点击。
- **偏好与请求字段**：安装级偏好 `relay.crossVendor`（`ask`、`allow`、`goal_only`，存 `relay_prefs`）或请求字段 `relay.consent: { vendor, decision, scope }`；缺失时返回 `409 RELAY_CONSENT_REQUIRED` 并附预览计数，不静默改成不送历史。
- **可见范围**：目的厂商指主模型请求的实际处理方；Harness 自配的辅助模型与记忆不在 Hub 可见范围（终稿 Q20 用只读探针核实各家的辅助模型路由）。
- **用例**：CS-01–CS-04（计划用例 G072-C06），另加工作区文件来源的端点每会话都问、`allow` 不覆盖四类前缀；厂商键四个夹具（Claude 用户设置里的 `ANTHROPIC_BASE_URL`、Codex 的 `OPENAI_BASE_URL`、dsh 的工作区 `.env`、Ollama `*-cloud`）都记为 `gateway:<host>` 且来源层正确，值不出现在任何日志（G069-C04；真机探针 P14 即 G074-R03）。

### 工作区观测子进程的环境

- **所有者与上限**（INV-26）：所有者是 WorkspaceObserver；只在交接边界观测一次，在租约之后、与目标启动并行；硬上限 250 ms，超时 SIGKILL 整个进程组并等待退出，在 execute 的 finally 中等待；全局并发 ≤ `MAX_PARALLEL_CONVERSATIONS`（4，`src/contracts/session.ts:315`【事实】）；失败或超时记 `unavailable{reason}`，交接单写“工作区未核验（原因）”，不阻塞交接。
- **git 从哪来**：启动时从 PATH 中工作区之外的绝对目录项解析一次 `git` 并记录 realpath，之后一直用这个路径；PATH 项在工作区内（direnv 的 `PATH_add`）或是相对目录的跳过；找不到即 `unavailable{error}`，不执行任何工作区内的可执行文件。
- **环境只保留**：git 的绝对路径、`HOME=<Hub 私有空目录>`、`LC_ALL=C`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_CEILING_DIRECTORIES=<工作区父目录>`，以及下一条的 `GIT_CONFIG_COUNT`、`GIT_CONFIG_KEY_n`、`GIT_CONFIG_VALUE_n`；不传 `GIT_DIR`、`GIT_CONFIG_PARAMETERS` 与任何 API key。这个私有空 HOME 只给观测子进程，与简报“不建空 HOME”所指的 Harness 进程无关。
- **过滤器中和**：先只读执行 `git config --list -z --show-origin`（≤64 KiB；超限、含 include、或任一驱动名不匹配 `^[A-Za-z0-9._-]{1,64}$` 时退回 tree 模式并记 `partial`），列出 `filter.*` 驱动名（取 `filter.` 之后到最后一个 `.` 之前的全部字符，名字可含点）；中和一律走 `GIT_CONFIG_COUNT`、`GIT_CONFIG_KEY_n`、`GIT_CONFIG_VALUE_n`，对每个名字设 `filter.<n>.clean=`、`.smudge=`、`.process=`、`.required=false`。不用 `-c filter.<n>.clean=`：`-c` 在第一个 `=` 处切开，名字含 `=` 的驱动照跑（git 2.54.0 上 `-c` 写法 clean 仍运行 2 次、环境变量写法 0 次【实测，VF3】）。另加 `--attr-source=<空树> -c core.attributesFile=/dev/null -c core.fsmonitor=false -c core.hooksPath=/dev/null`；驱动名按配置文件的 stat 缓存。
- **范围**：`git -C <工作区> rev-parse --show-toplevel --git-dir` 的 toplevel 必须等于工作区 realpath，gitdir 必须在工作区内，否则 `unavailable{gitdir_outside}`；工作区是 `/`、`$HOME` 或其父目录时不扫描（`root_is_fs`、`root_is_home`）；只用 `status --porcelain=v2 -z --ignore-submodules=all -- .` 与 `diff --numstat --no-ext-diff --no-textconv -- .`；只碰 realpath 在工作区内的路径，lstat 与 O_NOFOLLOW，`.git/index` 的 mtime 不变；LFS 文件记“未核验”；排除数据根与 `.tmp/`。
- **复用与存量**：返回时 HEAD 与 `.git/index` 的 mtime 未变且距上次观测 ≤60 s，复用上次的观测行；结果只存有界摘要：改动优先、≤1,000 项，另存计数与全量指纹；非 git 目录最多数 2 万项。
- **用例**：WS-01–WS-06（计划用例 G071-S01）：clean、process 过滤器与 include 配置的标记文件 0 次（含名字 `a=b`、名字带点的驱动）；HOME 配置 lfs 与假 git-lfs 不触发；HOME 是仓库而工作区是其子目录时不出现 `../`；gitdir 指向工作区外时拒绝；子进程环境恰为白名单；数据根在工作区内（含符号链接、大小写与 firmlink 写法、反向包含）时报 `data_root_in_workspace` 且观测结果不含 data；PATH 含工作区内目录时假 `git` 不被执行。

### 数据根、密钥与工作区（INV-36）

- **为什么**：数据根默认 `resolve("data")`、工作区默认 `process.cwd()`（`src/cli/session-application.ts:17–18`、`src/cli/web.ts:32`【事实】），`README.md:15` 的启动命令以相对路径 `data` 作数据根【事实】。目标 Harness 对工作区有读权限，数据根在工作区里时它能直接读到 `gateway.sqlite` 里的全部会话，同意与脱敏对它没有意义。
- **检查**：启动时与每次 `admit` 检查数据根、HMAC 密钥文件与工作区是否互相包含：沿父目录逐级比较 `(st_dev, st_ino)`，不比较路径字符串。数据根用 `fs.realpathSync`（`src/infrastructure/session/sqlite-store.ts:31`、`content-store.ts:58`【事实】），工作区用 `fs.promises.realpath`（`binding-factory.ts:6`、`:40`【事实】），在 APFS 上前者不折叠大小写而后者折叠【实测，VF3】；firmlink 写法 `/System/Volumes/Data/Users/…` 也会让前缀比较漏判。另在工作区内做有界查找（深度 ≤6、≤2,000 项、≤100 ms）数据根的所有权标记 `.harness-gateway.json`（`sqlite-store.ts:31`【事实】），找到即视为包含：照提示把数据目录复制走之后，旧的 `./data` 还留在工作区。
- **包含时**：启动时记录告警；对该工作区的全部会话在界面上告警，首次发送时要求确认（库里是全部对话、别家内容、未脱敏输出与已撤回同意的内容，不只跨厂商的）；跨厂商（目的厂商键 ≠ 来源厂商键）的交接受理即 `409 RELAY_UNAVAILABLE{reason:"data_root_in_workspace"}`，界面写“HarnessHub 的数据目录在这个工作区里，目标 Harness 能直接读到它；把数据目录移到工作区外（`--data-dir`）后再交接”；同厂商与单 Harness 对话可继续；观测排除数据根与 `.tmp/`。
- **附件物化与密钥移出数据根**（D5）：现状带附件的回合把 `<数据根>/content/files/<id>/<name>` 写进提示（`content-store.ts:151–172`、`src/infrastructure/control/attachments.ts:34`【事实】），读权限不受沙箱限制的同用户目标顺着这个路径能读 `gateway.sqlite` 与 `relay-key`【推断，据产品文档：Codex workspace-write 可全盘读，Claude Code 的 Bash 默认不在沙箱】。改为物化到 `os.tmpdir()` 下每个会话一个 0700、名字 ≥128 bit 随机的目录，所有者 ContentStore；目录内仍是 [ADR-023](../decisions/0023-attachment-input.md) 第 3 条的稳定只读副本（内容寻址、每次授权前复核摘要、缺失即重新物化，同一会话的后续回合按同一路径仍可读），随会话删除路径一并删除，启动时清理没有对应会话的残留；不再每个 Run 一个目录、随 Run 删除；`relay-key` 放在数据根之外（见上）；路径解析集中在一处。
- **G4 的表述**：工作区内不可达；同用户可读的部分以目标自己的沙箱为界。
- **不在本版**：默认数据根移到工作区外是 CLI 默认值的变更，牵动现有部署（4317 服务）的数据位置，需独立 ADR（D8：本版只检查、失败与提示）。交接单“未包含”一节不提 HarnessHub 的存放位置，固定结尾为“这些内容没有附上，你也无法读取；需要时以工作区为准。”
- **用例**：WS-05、WS-06 与 admit 的数据根检查（三种写法与标记查找都报 `data_root_in_workspace`，同厂商可继续、全工作区告警），计划用例 G071-S01、G072-S01；G071-C05 在 macOS APFS 上核对大小写与 firmlink 写法的工作区 realpath。

### 日志与诊断的隐去集合

- 交接单正文不写日志。
- **诊断隐去的行**：现状按“消息开头 32 字”匹配隐去对话内容（`src/web/run-diagnostics.ts:52–61`【事实】）；扩展为某行出现交接单 ID（含转义形式），或出现本回合所发正文中任意 ≥16 字的行（Aho–Corasick），就隐去这一行及其续行。Hermes 的 ACP 服务把每条提示的前 100 字写进自己的日志（`run-diagnostics.ts:7–11`【事实】），按 ID 与行匹配隐去。
- **诊断的秘密规则**：接入 `SecretScannerPort` 的 diagnostics 档。
- **固定文案**：接力代码的异常一律用固定文案，不引用输入片段（现状 `JSON.parse` 的报错片段经 `errorRecord` 进入 `run.error`，`src/cli/session-application.ts:32–34`【事实】）；接力错误只带错误码与计数。
- **其他不落库或不记录的值**：自由文本答复继续不落库（`src/contexts/session/application/runtime.ts:226–236`【事实】）；Harness 配置里的端点值不写日志；SSE 不含正文、原值与原值的哈希（AP-03）。
- **INV-29 的验证**：在 relay 表、relay 事件、正文、日志中 grep 原值、sha256(原值)、sha1、md5，均为 0（原型 5d：0【实测】）；RD-06 拆成 06a（出境范围，须通过）与 06b（既有命令指纹的已知违例）。
- **已知违例**：现有命令指纹 `sha256(JSON)`（`runtime.ts:783`、`src/cli/session-application.ts:30`【事实】）含审批答复的 `secret` 输入（`runtime.ts:221`【事实】）与发送原文（`runtime.ts:347`【事实】），属于接力范围之外的既有机制，登记为已知违例，建议独立 ADR 迁移为 HMAC（终稿 Q19）。
- **用例**：DG-01（peer 以多行、JSON、`ensure_ascii` 三种形式回显提示，回显精确集合里的值，诊断中均为 0 次）、DG-02（畸形 JSON 里的金丝雀不进 `run.error` 与下一份交接单）列入 RelayBench-X 的门槛（终稿 13.1）；终稿第 17 节没有为它们单列计划用例。

### v1.1 与 v1.2 通道（deferred）

- **文件视图**（G076，deferred）：数据根与工作区互不包含已是全局前提；目录按内容存储方式物化（0400、内容寻址、每次授权前复核）；目录名 ≥128 bit 不可猜测，上级目录不交给 Harness；目录里没有 `.claude/`、`AGENTS.md`、`CLAUDE.md`、`.git`；副本只放已脱敏、已获同意的正文，派生副本只在第一次经同意的交接之后生成；撤回时先提交“停止供给”，再留墓碑并删除文件（跨文件系统不能原子）。
- **stdio 接力 MCP**（G077，deferred；INV-34 在 v1.2 生效）：shim 随 Hub 安装目录发布，挂载前核对哈希；规格只含绝对路径，无 headers、无 env 秘密；shim 归 Hub 监督的进程组，结束绑定 2 s 后 `ps` 无残留；工具列表在建会话时固定；单次结果 ≤16 KiB；只读已脱敏、已获同意的物化正文。
- **永不**：回环 HTTP 加 bearer 的接力 MCP（Claude 把 MCP 规格放进 argv）；Hermes 挂 MCP；Claude `additionalDirectories`（探针证明不扩大写范围之前）。

### 用例归属

| 用例 | 覆盖 | 计划用例 |
|---|---|---|
| RD-01–RD-10 | 已知秘密与形状规则（含 base64 三种对齐、十六进制、ANSI 在秘密内部、`AWS_PROFILE=default` 不误伤） | G070-S01…S10（security） |
| RD-08 与第二段原样 | HMAC 密钥三种异常；第二段原样加卡片提示 | G070-S12（security） |
| IN-01–IN-06、模糊 10,000 例 | 注入、可见化、伪造标记、「」槽 | G070-S11（security） |
| WS-01–WS-06 | 观测子进程 | G071-S01（security） |
| 数据根检查 | 三种写法与标记查找 | G072-S01（security） |
| CS-01–CS-04 | 同意 | G072-C06（integration）；厂商键夹具 G069-C04（unit）、G074-R03（probe，P14） |
| AP-01–AP-03 | 跨源与缺 CSRF 的请求、跨会话 packetId、排除与放行、SSE 内容 | G073-S01（security） |
| IM-01、DG-01、DG-02 | 导入卫生与诊断 | RelayBench-X 门槛（终稿 13.1）；相关的协议用例 G069-C06（`userTextOf`）【推断】 |
| INV-29、INV-33、INV-34、INV-36 | 见上各节 | G070-S01…S10 与 G073-S01；G072-C06 与 G074-R03；G077-C01（deferred，v1.2 生效）；G071-S01 与 G072-S01 |

### 写入阶段提出、终稿已修订处置的点

处置见[第四轮处置表](../proposals/relay/round4/v3-dispositions.md)末节；本文件正文已按修订后的终稿改写。记录如下：

1. 终稿 10.6 威胁表“用户贴入的内容”一行改为：历史里的用户原话、首行与附言经三层脱敏，第二段永远原样（5.5、D4、INV-29）。
2. D5 改为附件物化目录按会话建、保留 [ADR-023](../decisions/0023-attachment-input.md) 第 3 条的稳定只读副本语义、随会话删除；不再每个 Run 一个目录。
3. `relayRequest.fingerprint` 改用 HMAC 会话子密钥（`HmacDigest`）。
4. 交接单 ID 只由正文派生，正文不变时 ID 不变；脱敏上下文与同意 seq 记在送达行；删除“脱敏上下文变化即换新 ID 并写 `supersedes`”。
5. “10 种形式”在终稿 10.2 逐一列出（①–⑩），G070 的夹具按它建例。
6. 跨厂商 = 任一来源的厂商键与目的不同（终稿 10.1 采纳本节的假设）。
7. 终稿 6.1 改为数据根检查只对跨厂商交接、且只对将要携带接力内容的回合生效。
8. `admit` 只做 `(st_dev, st_ino)` 比较（≤1 ms）；≤100 ms 的标记查找在启动时与工作区顶层目录 mtime 变化时做并缓存，不进受理→派发增量的预算（终稿 10.1，G072）。
9. `GET …/relay/:packetId` 返回存储的正文、不复扫，`ETag` 为存储正文的 sha256；出境扫描只在为发送而渲染时做一次。
10. `consentLogSeq` 记在送达行（终稿 10.4 改正）。
