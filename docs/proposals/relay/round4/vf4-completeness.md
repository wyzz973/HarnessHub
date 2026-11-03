# VF4 完整性审查：第二版接力架构的缺口与自相矛盾

VF4（完整性审查），2026-11-03。对象：[第二版架构](../round3/v2-architecture.md)（`v2:行号`；未跟踪的 `relay-architecture.md` 与它逐字节相同）与[处置表](../round3/v2-dispositions.md)（`disp:行号`）。对照：[简报](../00-brief.md)、[裁定](../02-round2-rulings.md)、RT1–RT5、[原型](../../../../spikes/relay/README.md)、`plan/*.json`、[check_design.py](../../../../tools/check_design.py)。代码行号以本工作树为准（与 `07a0825` 相同）。未运行任何 Harness，未碰 4317 与 data/；唯一的测量是在 scratchpad 用 Node 26.11.1 自带的 SQLite 3.53.4 内存库验证冲突语义。

## 0. 结论

Q1–Q11 都有答案（Q3 部分），S1–S16 都有走查，处置计数一致；但不宜原样定稿。共 21 条发现：blocker 2、major 14、minor 5。两条 blocker 都会造成数据错误：F01“只发这条消息”把欠交历史记成已知；F02 v12 迁移没有给绑定排纪元（RT1-B3 的迁移部分未落实）。F01–F08 与 F15、F16 修完之前，不宜写入 ADR-0055 与 plan。

## 1. 覆盖核对

- **Q1–Q11**：Q1、Q10 无问题。其余：Q2 后台补建无写入路径（F07）；Q3 未答“不污染原生转录”（F21），Claude 清空合成不可实现（F04）；Q4 F02、F03；Q5 零注入缺真机（F14）；Q6 F01、F11；Q7 F06、F09；Q8 F06、F17；Q9 偏好无存储（F07）；Q11 F07、F08、F15、F16。
- **S1–S16**：每个场景都有走查（v2:1148–1163）。有问题的是：S1 与 S2 的样例（F19），S4（F06），S13（F04），S15（F05）。“同时切换”没有单列走查，但 RT2 §3 已核对它成立。
- **计数**：修正 97 条，部分修正 8 条；按严重度为 21/57/27；18.2 共 35 行。这些都与 disp:7 相符。落实上的缺口见 F12 与 F14。

## 2. 发现

### F01【blocker】“只发这条消息”（`attach:"none"`）会把欠交的历史记成已知（v2 4、6.3、7.1、7.2、9）

- **场景**：Claude 做了 3 轮后切到 Codex，finalize 时脱敏器抛错，用户点［只发这条消息］。WorkBuddy 作目标时，这也是唯一的选项。目标绑定是 fresh 状态，这一回合不带包，结果为 recorded。
- **证据**：
  - 【事实】`attach` 可以取 `"none"`（v2:304），但全文没有定义它的语义；`plan()` 只处理 `full`（v2:708）。
  - 【事实】7.2 的 fresh 行 j 格写着：只要 recorded，就进入 `synced{throughSeq=contextThroughSeq}`（v2:768）。这里不检查 need 是否为空，只有 7.1 写了“（当时为空）”（v2:756）。
  - 【事实】pending 行写着“need≠∅ 时必带包”（v2:770），与这个选项矛盾。
  - 【推断】Claude 的 3 轮会落到水位之下，永远不会补交。之后即使选 `attach:"full"` 也没用：它只降低 floor，不动 base。这违反 v2:773 的属性和 INV-14。
- **修正**：【建议】`plan()` 加 `attach=="none"` → 原样发送，本回合不产生 native 证据、sync 不变，下一条照常附包；j 格只在派发时 need=∅ 时生效；INV-30 测试加 attach none 与 WorkBuddy 两例。

### F02【blocker】v12 迁移没有给归档绑定与现行绑定排纪元（v2 14.4、2）

- **场景**：v12 下，Claude 做了 10 轮后执行 native-reset（`runtime.ts:401–416`）；新绑定的第一条输入是 `/compact`（D1 形态）；之后升级到 v13。
- **证据**：
  - 【事实】v2 要求纪元跨绑定单调递增（v2:93），并按 `executedOn ≠ (X, e)` 判定外来事实（v2:88）。
  - 【事实】14.4 只规定导入与分支绑定为纪元 1、清空过的绑定为纪元 2。其余绑定、archived 绑定该取什么纪元，v12 Run 的 `executedOn` 怎么推出，都没有写（v2:1125–1127）。
  - 【事实】RT1-B3 指出过这个问题（rt1-invariants-storage.md:50），处置表也称已修正（disp:15、disp:47），但正文没有相应规则。
  - 【推断】旧的 10 轮与新绑定同为纪元 1，不会被当作外来事实；need 可能为空，于是按 v2:771 视同 synced，这 10 轮就永久丢失了。
- **修正**：【建议】按 `binding_prepared{resumed:false}`、`branch_requested` 与归档切分谱系，纪元依次为 1..n、每次清空再加 1；v12 Run 的 `executedOn` 取其派发时所在的谱系段；加“reset + D1”夹具与属性测试。

### F03【major】送达状态表与 plan()、planReturn 有四处不一致（v2 3.2、6.3、7.2–7.4）

- **场景**：Hermes 回放失败、一次核对多个标记、unknown 后重发、声明 lateDelivery 的 Driver。
- **证据**：
  1. synced 绑定遇 outside_window/unavailable：v2:769 进 suspect、可能停下；v2:799 却说“按 pending 规则重发一次”。送达行此时已是终态 recorded（v2:194–196、v2:1072），照后者会重发已送达的包。
  2. planReturn 一次核对 ≤4 份包（v2:779），suspect 行要“退回到最后一个仍在的标记”（v2:771），但 `verifyDelivered` 只回一个结果（v2:156、v2:192）；planReturn 还读 pending 的 mark，pending 没有 mark（v2:277）。
  3. pending 行的 a 格写着“不发生”（v2:770），可同一行的 i 格和 `plan()`（v2:713）都会派发 resend；resend 之后进入什么状态没有定义。
  4. 不许自动重发的守卫（autoResends 与 lateDelivery）只写在注释里（v2:713），代码对任何 pending 都给 resend。v2:800 禁止自动重发，但没写这时下一条该发什么。
- **修正**：【建议】synced 遇这两种结果保持 synced，只记 `relay.verified`；`verifyDelivered` 按标记逐个返回；补上 (pending, a) 格；`plan()` 写出守卫，不许自动重发时原样发送、状态不变。

### F04【major】Claude `/clear` 的合成路径没有接口，并会被现有转换规则拒绝（v2 8.1、7.2、14.3）

- **场景**：用户输入 `/clear`，Driver 合成 `session/new`；按 v2 的设计，Runtime 应归档旧绑定、新建 fresh 绑定（v2:820）。
- **证据**：
  - 【事实】Driver 接口无法回报“原生会话已替换”（v2:156）。checkpoint 在派发前就已取得（`runtime.ts:1378`），结算时用它把绑定置为 ready（`runtime.ts:1496`）。
  - 【事实】归档一个绑定，必须在同一变更里带上 native-reset 命令（`state.ts:418–424`）；v2:1119 没有放宽这一条，7.2 的 e 列（v2:768–771）也没有覆盖这种情形。
  - 【推断】实现时会抛 INVALID_TRANSITION，经 `runtime.ts:796` 让整个 Runtime fatal；或者新会话的 ID 丢失，下一轮又 resume 回旧会话。
- **修正**：【建议】`BackendResult` 加 `native.replaced.checkpoint`；7.2 加 e′ 列；14.3 加对应规则与无效样例。

### F05【major】两处调用方向违反 B1（v2 3.1、3.2、9）

- **场景**：Hub 重启后的恢复；脱敏规则的引用。
- **证据**：【事实】
  1. v2:154 与 v2:854 让 `recoverSession` 调用 `coordinator.recover`。但 `recoverSession` 是领域纯函数（`state.ts:466`），由 `claimAndRecover` 在 Store 打开时调用（`sqlite-store.ts:579`），这时 Coordinator 还不存在。B1 也禁止领域层引用应用层。
  2. 领域层的 `redaction.ts` 引用了 `src/infrastructure/text/secret-rules.ts`（v2:116），G063 的边界检查会失败。
- **修正**：【建议】写纯函数 `recoverRelay`，由 `claimAndRecover` 在同一事务内调用；规则数据移到 src/contracts 或经端口注入。

### F06【major】已知秘密集合在交接时会变大，导致摘要整体失效（v2 10.2、6.4、11.1）

- **场景**：API key 用户在 S4（200 轮）中首次交给 Hermes，而 Hermes 的环境里有一个新密钥。
- **证据**：
  - 【事实】集合 (a) 由本会话所有绑定的环境值组成（v2:887）；目标的环境要到 prepare 时才算出（`binding-factory.ts:156`）。
  - 【事实】摘要记录的集合指纹一旦不同，就只能标为 behind（v2:253）；冷路径最多等 1 s（v2:744）。LRU 不随集合变化失效（v2:745）。
  - 【推断】200 条摘要会同时变成 behind，v2:946–947 的时延目标随之失效，S4 的走查（v2:1151）也不再成立。
- **修正**：【建议】摘要用的集合改为安装级（取全部已配置 Harness 的引用值）；目标新带来的值只在出境前补扫最终正文（v2:891）；LRU 键加集合 HMAC。

### F07【major】后台与安装级的写入没有提交路径，两项偏好没有存储（v2 3.2、6.4、10.4、14.1）

- **场景**：懒重建、`realized`、回合外的窗口上报、全局同意、各项偏好。
- **证据**：
  - 【事实】`transact` 每次都会重写整份快照（`sqlite-store.ts:343–363`）；`commit` 遇到预期之外的错误一律调用 `fail()`（`runtime.ts:796`）。
  - 【事实】这些写入都没有提交路径：懒重建（v2:743–744、v2:871）；idle 时的 `realized`（v2:198、v2:792）；回合外写 `relay_windows`（v2:1119）；无会话的同意写 `relay_log`（v2:909、v2:997）。
  - 【事实】`relay.crossVendor`（v2:910）与返回偏好（v2:789）没有表，也没有 API。
  - 【推算】7.6 MiB 时一次提交约 144 ms（v2:947），做不到“每片 ≤20 ms”。
- **修正**：【建议】增加不升 version 的 `writeRelayRows` 与安装级的 `appendRelayLog`、`upsertWindow`，写明所有者与失败语义；`realized` 在下次使用时惰性结算；两项偏好进 v13 DDL 与 12.4。

### F08【major】交接单去重会丢掉逐 Run 的清单；OR IGNORE 会吞掉约束（v2 4、14.1、14.3）

- **场景**：用户撤回同意后再同意并重试；或两条输入的前 200 字相同。
- **证据**：
  1. 【事实】ID 只由正文派生（v2:735），但 `consentLogSeq`、输入 HMAC 这类逐 Run 字段存在 `relay_packets` 里（v2:231–240、v2:1037–1040），而写入用的是 INSERT OR IGNORE（v2:1078）。【推断】第二个 Run 的清单会被静默丢弃，INV-13 不再成立。
  2. 【实测】OR IGNORE 会跳过违反 CHECK 的行；随后写送达行时报外键错误（787）。改用 `ON CONFLICT DO NOTHING` 则照常报 CHECK 错误（275）。【事实】任何 SQLite 错误都会让存储进入 failed（`sqlite-store.ts:626`）。【推断】因此 INV-35（v2:1116）在 CHECK、触发器、外键这几类错误上不成立。
  3. 【实测】SET 子句含 outcome 的 unknown→unknown 被触发器拒绝（1811，同样会置 failed），所以 v2:770 的 reason 改写只能单独更新 reason。
- **修正**：【建议】逐 Run 字段移到 `relay_deliveries`；写入改用 `ON CONFLICT DO NOTHING`；INV-35 收窄为预期内的接力失败。

### F09【major】脱敏范围有两处自相矛盾（v2 5.5、10.6、14）

- **场景**：用户在当前输入里贴了一个令牌；或者钉住了一条含密钥的消息。
- **证据**：
  1. 【事实】v2:467 写第二段“一字不改”，v2:469 与 v2:924 却说第二段也要脱敏。原样路径是逐字节发送的（v2:17）。
  2. 【事实】`relay_pins.quote` 与 `relay.pin_added` 都存原文（v2:1060、v2:1093），而 INV-29 覆盖了这两处（v2:893、v2:1110）。
- **修正**：【建议】当前输入一律原样，只脱敏历史；钉住改存 `(messageId, offset, length)` 与 HMAC。

### F10【major】受理时预检拿不到所需输入，厂商键函数给不出 `gateway:<host>`（v2 3.2、6.1、8.1）

- **场景**：用户发消息时，`admit` 要判定同意与厂商。
- **证据**：
  - 【事实】`send()` 是同步的（`runtime.ts:343`），而 control 实例要在租约取得、环境算出之后才建立（`binding-factory.ts:147–172`）；`relay?` 却挂在实例上（v2:156、v2:658）。
  - 【事实】厂商键函数规定只读变量名、不读值（v2:209），但 v2:820 与 v2:823 都要从值里取 host。
- **修正**：【建议】工厂加同步的 `relayCapabilities`；结算时把 `{model, authKind, baseUrlHost}` 缓存到绑定上，`admit` 只读这份缓存。

### F11【major】open 之后发生的失败被写成“启动前失败、绑定不变”（v2 6.1、9、12.4）

- **场景**：finalize 时才发现 `vendor_changed`、标记缺失、`redaction_failed`，或者窗口小于 12k。
- **证据**：
  - 【事实】finalize 在 open 与 `binding_prepared` 之后执行（v2:660）。这时原生会话已经建立（`codex.ts:350`），绑定已写入（`runtime.ts:1384`），结算时还会被置为 ready（`runtime.ts:1496`）。v2 却写“绑定不变”（v2:851）、“启动前判定”（v2:638）。
  - 【事实】`RELAY_INPUT_LIMIT` 被列为 429（v2:998），但它在 Run 建立之后才抛出，HTTP 已无从返回。
- **修正**：【建议】按“受理 / 启动前 / open 后”列出各错误码，写明 open 后失败时绑定与空会话的去向；窗口检查前移到 prePlan。

### F12【major】处置表称已修正、正文却没有的条目

- **场景**：逐条用处置表对照正文。
- **证据**：
  - RT1-M1 要求用 fold 校验替代 K7（disp:20），正文没有。而 `sourceRunIds` 现在写空（v2:319），`state.ts:359–361` 的校验因此失效。
  - RT2-19 要求扩展 `message.accepted`（disp:65），14.2 没有。
  - RT1-m6 要求的 legacy chain（disp:37），14.4 没有。
  - RT4-M2：命令指纹保留了下来（v2:893），于是 RD-06（rt4-security-privacy.md:372）按设计必然失败。
- **修正**：【建议】把上述几条写进 14.2–14.4；RD-06 拆成 06a 与 06b，06b 登记为已知违例。

### F13【major】“未经探针”对六家 Harness 怎么处理没有定义（v2 2、6.1、17）

- **场景**：R3–R6 已上线、R7 还没跑，用户切到 Codex。
- **证据**：
  - 【事实】能力声明要等探针通过才生效（v2:102）；未经探针时返回 `RELAY_TARGET_UNVERIFIED`（v2:658）。但探针在最后的 R7（v2:1182），而且没有发布门。
  - 【推断】结果只有两种：要么六家全部返回 409；要么所有送达都记 unknown 并自动重发。另外，若按版本门控，还会与 ADR-053 冲突。
- **修正**：【建议】定义“已声明 / 已探针”两态；R3–R6 等该 Driver 的 P2、P3、P6、P11 通过后才启用。

### F14【major】76 条要求中有两条落实缺口（v1 18、v2 18.2）

- **场景**：对照第一版第 18 节逐条核对。
- **证据**：【事实】
  - J3 M1 要求零注入“另做真机两家”（j3-product-native.md:182），v1-architecture.md:1042 也记为采纳；但 v2:1023 没有这个探针，v2:1111 也缺压缩后与外部编辑后两例。
  - J2 M10 要求的冷回合计数不在 v2:954。
  - 另见 F01、F07、F15、F17。
- **修正**：【建议】增加 P15（两家各 20 轮，从原生转录读回，断言与原文逐字节相同）；补上冷回合计数。

### F15【major】实施切片映射不到 plan/tasks.json（v2 17）

- **场景**：按第 17 节编写 tasks.json。
- **证据**：
  - 【事实】check_design.py 要求：文件只有一个所有者且不含通配（:71–85）；用例归所属任务（:104）；切片有决策文件（:434），路径都有所有者（:437、:448）。
  - 【事实】v2 只列了 G006 与 G010 两个所有者，而被改动的文件还分属 G004、G007、G008、G026、G028、G031、G032、G034、G050、G054、G059、G060、G064。
  - 【事实】路径有误：`web/src/lib/api.ts` 不存在，实际是 `web/src/api.ts`；还有用了花括号与通配的写法（v2:1179–1182）。
  - 【事实】全文没有提到 ADR-0055；`docs/contracts`、invariants.md 都没有所有者。
  - 【事实】G024-C02 与 C006-C02 要求超限时报错，与 v2:849 冲突。
- **修正**：【建议】每片建一个任务并展开 owns；共享文件写明“移交自 Gxxx”；切片 decision 用 `0055-relay-and-context-scheduling.md`；改写两条冲突用例。

### F16【major】新增的不变量没有计划用例（v2 14.3）

- **场景**：把 INV-29–36 写进 invariants.md 后运行检查。
- **证据**：【事实】check_design.py:412 要求每个 INV 都有用例，而 v2:1110–1117 只写了验证方式，没有用例；其中 INV-34 需要一条 deferred 用例。
- **修正**：【建议】与不变量同次增加用例：

  | 不变量 | 层 | 内容 |
  |---|---|---|
  | INV-29 | security | RD-01–08、AP-03 |
  | INV-30 | integration | 零注入、attach none |
  | INV-31、INV-32 | property | 状态转换、账目恒等式 |
  | INV-33 | integration | CS-01–04 |
  | INV-34 | deferred | v1.2 生效 |
  | INV-35 | integration | 故障注入（按 F08 收窄） |
  | INV-36 | security | WS-05 |

### F17【minor】几处数字与 v2 自己的形状或模板不符（v2 0、5.4、13.2）

- **场景**：用最长取值与新模板重新核对 v2 的上限和预算。
- **证据**：
  - 每个绑定 ≤512 B 的上限，沿用的是第一版实测的 476 B（rt3-performance-cost.md:64）。【推算】v2 的 pending 状态约 637 B，换成长 gateway 主机名时约 817 B。
  - 【推算】新模板约 445–460 o200k token，超过 420 的上限；而且 `FRAME_CAP`（v2:673）用的是 est/2 口径，与 o200k 不同。
  - v2 列了 10 个视图，但只按 8 个视图写预算（v2:1015–1019）。
- **修正**：【建议】按最长取值重新实测上限，按口径分别写出目标，并重算预算。

### F18【minor】术语、编号与枚举不一致

- **场景**：照文档定义类型与交叉引用。
- **证据**：
  - `brief` 一词同时指档位和包类型（v2:98、v2:673）。
  - K、Q 两套编号混用；v2:881 引用的 O16 不存在。
  - v2:1102 写“INV-01–28 不变”，与后文改写 INV-13 等相矛盾。
  - reason 枚举缺 `storage_quota`（v2:851、859）；`S_A`（v2:783）没有定义。
- **修正**：【建议】把要点包改名为 `anchor`；编号加前缀以区分来源；所有枚举集中到第 4 节声明。

### F19【minor】样例与走查中有事实错误（v2 5.6、16）

- **场景**：按 v2 自己的规则重算样例。
- **证据**：
  - S1 的 `summary.ts` 应为 +61，文中写成了 +62（v2:546）。
  - 增量样例里的“第 3 轮期间 +9 −4”（v2:583）推不出来：观测只在交接边界进行（v2:29）。
  - S1 标为“完整记录”（v2:1148），而 12.2 里它是 full 档的标签，S1 用的是标准档。
- **修正**：【建议】改正数字；增量样例只写两次观测的计数；S1 改标为“交接单（标准）”。

### F20【minor】实现细节与兼容性

- **场景**：照文档实现 Driver，并保留证据。
- **证据**：
  - Hermes 的核对位置写的是“标题行”（v2:824），不在 v2:191 列出的位置类型里。
  - `deliveryPosition` 的调用晚于写入它的事务（v2:647–648）。
  - Unicode 版本没有写进 policyVersion（v2:11）。
  - 接续等级的格式从字符串改成了对象（v2:285–291），而现有事件仍用旧格式（`runtime.ts:275`）。
  - R7 要删除 `spikes/relay`（v2:1182），这会让 check_design.py:384 报断链。【实测】终稿位置的 `relay-architecture.md` 仍用 round3 的相对链接，check_design.py 现已报 missing local link。
- **修正**：【建议】Hermes 改用 `seq` 位置；`deliveryPosition` 移到写入事务之前；写明旧格式的兼容读法；删原型时保留 README 与 `results.json`。

### F21【minor】撤回、上限与原生转录的语义没有定义（v2 8、9、14.2）

- **场景**：撤回排除；`relay_log` 写满；用户之后在原程序里 `--resume`。
- **证据**：
  - `exclusion_withdrawn`（v2:1094）没有说明撤回后是否重新欠交。
  - `relay_log` 达到上限（v2:873）后的行为没有写。
  - 交接单会永久留在原生转录里，而 Q15（v2:1303）没有给出取舍。
- **修正**：【建议】把这三处的语义写明；第 8 节补上这一取舍，以及 v1.1 的缓解办法。

## 3. 假设与未核实项

- 计划映射按当前 plan（83 任务、590 用例、18 切片）判断，未改 plan。F06 只在目标带来新环境值时触发。F17 为推算（紧凑 JSON；token 按字符比例外推）。唯一的实测是 F08 的 SQLite 语义。
