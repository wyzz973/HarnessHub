# R7 · 人类高风险行业的交接协议与软件交接体验

调研员：R7（第一轮）。阅读日期：2026-11-02。仓库基点：`cc/relay-design` @ `07a0825`（只读）。
标注约定：**【事实】** 来源原文或摘要所述；**【推断】** 本文的跨领域映射或对代码的阅读判断；**【建议】** 给接力设计的提案（未被采纳，待评审）。

## 1. 范围与方法

- **对象**：医疗（I-PASS、患者与家属参与的 I-PASS、SBAR、Joint Commission 警示、sign-out 事故分析、warm handoff）；航空与空管（正向控制权交接、FAA 岗位交接 SOP）；跨行业比较研究（航天任务控制、核电、铁路、救护调度）；运维与事故指挥（Google SRE、PagerDuty、incident.io 模板、GitLab）；事故教训（Piper Alpha、Continental Express 2574）；接力赛规则与技术；软件产品（Amp、Claude Code、Codex CLI、Cursor、VS Code 的 harness 交接与自定义 agent handoffs、GitHub Copilot coding agent 与 Agent HQ、Linear AIG、OpenAI Agents SDK、Devin）；2025–2026 的 Agent 交接实证论文（Handoff Debt、Handoff Tax、MAST）；HarnessHub 本机界面与上下文构建源码。
- **方法**：一手优先——PubMed/E-utilities 摘要、FAA 原文、World Athletics 规则 PDF、Joint Commission PDF、Patterson 2004 全文 PDF、厂商文档、GitHub issue API、openai/codex 仓库原文、arXiv HTML 全文；打不开的只用搜索摘要，并在来源清单逐条注明。
- **局限**：
  - 医疗证据多为多中心前后对照，不是随机试验；I-PASS 的效果来自“助记符 + 训练 + 观察反馈 + 文化”的捆绑，不能归功于模板本身 [S1][S2]。
  - 人类交接依赖双方记忆与面对面互动，LLM 接手方除了收到的内容外没有任何先验记忆，类比只能作为设计启发（均标为【推断】）。
  - 2026 年的两篇 Agent 交接论文是预印本、单次运行、SWE-bench 环境，且是“同一 scaffold 内换模型”，不等于 HarnessHub 的跨 Harness 交接 [S33][S34]。
  - Cursor、Devin 没有找到可靠的一手交接文档；PMC 页面出现人机验证，未绕过，改用 PubMed 摘要。
  - 遵守简报第 5 节：未运行任何 Harness 会话，未读用户对话，未碰 4317 与 `data/`。

## 2. 发现

### 2.1 医疗：结构化、接收方综合、捆绑式落地

1. 【事实】I-PASS（NEJM 2014，9 家医院、10,740 次入院）：医疗差错从 24.5 降到 18.8/100 次入院（−23%，P<0.001）；可预防不良事件 4.7→3.3（−30%，P<0.001）；不可预防不良事件 3.0→2.8 无显著变化；6/9 家医院显著下降；书面 9 项、口头 5 项关键要素的纳入率全部显著上升；口头交接时长 2.4→2.5 分钟/患者（P=0.55），住院医工作流无显著变化 [S1]。
   【推断】结构化交接**没有增加交接时长**，同时提高了要素完整性。这为“交接单有固定字段，但不应让切换更慢”提供了人类侧的先例。
2. 【事实】I-PASS 五要素：Illness severity、Patient summary、Action list、Situation awareness & contingency planning、Synthesis by receiver。接收方综合是指接收方概括听到的内容、提问、重述关键待办 [S3]。二手资料提到，在实际 sign-out 中最常缺的是第一个 S（情境意识与应急计划）[S3，仅摘要]。
3. 【事实】患者与家属共同参与的 I-PASS（BMJ 2018，7 个儿科病区、3,106 次入院、13,171 患者日）：有害差错（可预防不良事件）从 20.7 降到 12.9/1000 患者日（−37.9%，P=0.01）；总差错 41.2→35.8，不显著（P=0.21）；查房时长无显著变化 [S5]。
   【推断】在场的、贯穿每次交接的那个人能拦截**有害**错误。在 HarnessHub 里，这个人就是用户：交接应当“当着用户的面”进行（见 [S15] warm handoff：交接在患者面前进行，让其听到并参与）。
4. 【事实】SBAR 的系统综述共纳入 11 项研究，测量了 26 个患者结局，其中 8 个显著改善。证据为“中等”，在规范电话沟通时最强 [S4]。
5. 【事实】Joint Commission 第 58 号警示（2017-09-12）[S2]：
   - 它引用的 2016 年估计：沟通失败至少部分导致了 30% 的医疗事故索赔，5 年内涉及 1,744 例死亡、17 亿美元。ACGME 调查发现，69% 的临床学习环境没有标准化交接流程。一家典型教学医院每天可能有 4,000 多次交接。
   - 它认为问题根源是发送方与接收方的**预期失衡**。
   - 最低内容包括：发送方联系方式、病情严重度、摘要、待办、应急计划、过敏、code status、用药、**带日期的**化验与**带日期的**生命体征。
   - 建议：不要只靠纸面或电子文档，要给提问留出机会；把多来源信息综合后再交，不要分别转述；助记符只是框架，必须配合训练和文化。
6. 【事实】Arora 2005（26 名实习医生、82 名患者、25 起事件）[S7]：
   - 失败分两大类：遗漏内容（用药、活跃问题、待回报的检查）和易出错的流程（缺少面对面讨论）。
   - 几乎所有失败都导致决策不确定，进而引起重复或不必要的检查。
   - 接收方希望交接“详尽但相关”，并回顾预期会出现的问题。
   【推断】“不确定 → 重复检查”正对应 Agent 接手方的“重读文件、重跑命令”，也就是 [S33] 所说的 handoff debt。

### 2.2 航空与空管：明确的转移时刻、自我简报、转移后复核

1. 【事实】飞行操纵的正向交接分三步：交出方口头交出 → 接收方说“I have the flight controls” → 交出方确认。同时建议目视确认对方确实在操纵，并在飞行前简报这套程序 [S9，扫描件与二手资料]。
2. 【事实】FAA JO 7110.65BB 附录 A《岗位责任交接 SOP》[S8，原文]（这是本次与 HarnessHub 结构最接近的协议）：
   - **问题陈述**：交接内容和方式因人而异，信息常被遗忘或覆盖不全；严重问题出在“依赖记忆、没有例程或系统提醒”的时候。
   - **方法**：采用自我简报。接班者先读状态信息区（Status Information Area, SIA）；只有“截至此刻”的动态信息才需要口头交换；SOP **规定了责任转移的确切时刻**；最后由被替换者监看并复核岗位，确认没有遗漏或错误显示。
   - **预防措施**：不催促；运行中每一项可能影响接班者的状态，一旦可行就记录下来；多人同时交接（合并或拆分岗位）时要格外谨慎。
   - **责任**：交出方负责把所知状态准确显示在 SIA 或转达出去；接班方负责在接受之前解决一切未决问题；双方对简报的完整与准确**负同等责任**。
   - **四步流程**：①预览（按清单读 SIA，观察设备、通话与交通，然后通知对方可以开始口头简报）；②口头简报（只讲 SIA 未列出的异常和特殊事项，接班者提问，交出者完整回答）；③接管（接班者声明已接管，交出者释放岗位并记下时间）；④复核（接班者核对并更新信息；交出者复查清单与 SIA，指出遗漏、更新或不准确之处，观察是否需要协助，最后签退）。
   【推断】对应关系：SIA ≈ 工作账本；口头简报 ≈ 只覆盖异常的叙述；接管声明 ≈ 交接单“已送达”事实；复核 ≈ 接手首轮之后的确定性差异检查。

### 2.3 跨行业比较：21 项交接策略（Patterson 等 2004）

1. 【事实】研究覆盖航天飞机任务控制、核电、铁路调度、救护车调度。21 项策略中有 19 项至少在一个领域使用 [S6]。
2. 【事实】交接失败的 7 种代价 [S6]：
   - 系统状态模型错误或不完整；
   - 不知道重要的数据或事件；
   - 对先前事件造成的影响没有准备；
   - 没有预见未来事件；
   - 缺少执行任务所需的知识；
   - 丢弃或重做进行中、或已约定的活动；
   - 不当改变目标、决定、优先级或计划。
3. 【事实】关键观察 [S6]：
   - 所有观察到的交接都是面对面、可以交互提问的。
   - 四个领域**都没有观察到 readback**（复述以核对），也没有“每次按相同顺序更新”。
   - 任务控制：交班前在日志里写一段话的班次摘要；交接后有 1 小时重叠，由交出者监看接班者工作；接班者先扫描近期日志，再评估现状（核电称为 “walk the board”）。
   - 所有领域：责任转移明确；让旁人一眼看出谁负责什么；关键活动期间推迟转移，短活动先完成再交。
   - 接班者的新视角能发现固着错误：16 次 NASA 交接中提了 75 个问题，其中 8 个用于发现错误。
   【推断】对 LLM 接手方来说，“交互式提问”对应的是**按需取用（pull）**，不是把一切塞进首条消息。“readback 未被观察到”说明复述不是高后果领域的必需品，接收方的主动核实才是。

### 2.4 运维与事故指挥

1. 【事实】Google SRE：IC 职位必须清楚地移交。交出者要明说“你现在是 IC 了，好吗？”，并在收到明确确认前不离开；移交要通知所有参与者，让任何时候都清楚谁在领导。IC 最重要的职责是维护一份活的事故文档：可以乱但必须可用，用模板，最重要的放在顶部 [S10]。
2. 【事实】PagerDuty：先在带外（如 Slack）给新 IC 上下文，再在通话里公开宣布移交，新 IC 也像新加入一样宣布自己。文档鼓励移交；更资深的人到场并不意味着自动换指挥 [S11]。
3. 【事实】incident.io 异步交接模板（2026-08-11）[S12]：
   - 写法：用带标签的字段，不写段落（接班者可能疲惫或刚被叫醒）。
   - 排序：进行中事件按严重度排；最近 24 小时的变更按“爆炸半径”而不是时间排。
   - 内容：已知问题，含被静默的告警及原因；待办带 owner 和截止时间，归属不清要明说；系统状态写 2–3 句。
   - 安静的班次也要交接，并明确写“无变更”。
   - 接班者读完后提问，显式接受 pager，记下姓名和时间。
   - 耗时：准备 10–15 分钟，同步 10–15 分钟。
4. 【事实】GitLab 把交接记录成 issue，由交出方填写模板并指派给接班方 [S43，仅摘要]。
5. 【事实】事故教训：
   - Piper Alpha：上一班拆下了一个压力安全阀，新班组不知道。许可证之间没有交叉引用，也没有清晰的交接程序 [S41，仅摘要]。
   - Continental Express 2574：换班后，已拆下的水平安定面螺钉没有被装回，交接单与工卡流程失效 [S42，仅摘要]。
   【推断】最致命的丢失信息是“**做了一半的危险状态**”。在 Agent 场景里，这对应未提交改动、半完成的迁移、仍在跑的后台进程，以及被取消的审批。

### 2.5 接力赛交接区

1. 【事实】World Athletics C2.1 技术规则第 24 条（文件 2026-07-01 修订）[S13]：
   - 交接区长度：4×100、4×200 为 30 m，接力起点线在区内 20 m 处；4×400 及更长项目为 20 m。
   - 交接起止：从接棒者第一次触棒开始，到棒只在接棒者手中时完成。判断是否在区内**只看棒的位置**；区外交接取消资格。
   - 掉棒由掉棒者捡回；不得在区外起跑。
2. 【事实】教练实践 [S14，仅摘要]：4×100 用盲接，接棒者在来者跑到预设标记时起跑，听口令伸手；4×400 用目视交接，因为来者疲劳、速度难以预测。另有教练主张由交棒者负责确认棒已握牢。
   【推断】交接方式取决于来者的状态：来者“疲劳”（上下文将满、刚失败、结果 unknown）时，接棒者要回头看，多做核验；来者状态好时可以快速盲接。区内加速对应“提前准备、按时交付”，“区外不得起跑”对应“交接单准备好之前不发起带副作用的执行”。

### 2.6 软件中的交接体验

1. **Amp**
   - 【事实】2025-10-23 Amp 移除了压缩，改用 Handoff [S16]：用户写下目标，Amp 分析当前 thread，生成新 thread 的起始提示和相关文件列表，并以**草稿**形式放进新 thread，供用户审阅、编辑后再发送。理由：压缩有损，摘要是否包含所需内容由 agent 决定，而且会鼓励冗长的 thread 和“摘要叠摘要”。
   - 【事实】2026-07-02 的文章写明：后来又加回了压缩，最长的 thread 压缩了 68 次以上，未压缩会超过 2,100 万 token [S17]。`read_thread` 被重写为按问题检索的子代理，会检查较新的消息是否修订、取代、回滚或否定了已找到的内容；它把工具调用视为“尝试”而不是“结果”；压缩摘要只用于定向，涉及精确需求、代码、命令、时序或验证时回看原文。文档仍保留 Handoff、`@T-…` 引用，提交会带 `Amp-Thread-ID` [S18]。
   - 【推断】最坚定的“交接替代压缩”派也走向了三者并存：**交接 + 压缩 + 按需回查原文**。
2. **Claude Code**
   - 【事实】官方文档 [S19]：
     - `/compact` 用结构化摘要替换对话，用户只看到一条 “Conversation compacted” 提示，摘要过程不在终端显示。
     - 压缩后会重新注入：项目 CLAUDE.md、自动记忆、计划、技能（每个上限 5,000 token，合计 25,000）；重读最多 5 个最近修改过的文件，超过 5,000 token 的只给路径引用；后台任务继续运行，并提醒模型不要重复启动。
     - 可以用 `/compact <焦点>`，也可以用 `/rewind` 做局部摘要。
     - 文档把会话内容按可见性分为“终端不可见 / 一行提示 / 完整显示”三层。
   - 【事实】用户诉求（GitHub）[S20]：
     - #667（2025-03）要求导出摘要，2026-01 以 not_planned 关闭。
     - #21243 称“静默的规格漂移”：模型和用户都不知道已经发生了压缩。
     - #21788 指出压缩前后都无法查看摘要。
     - #26771（2026-02，仍开放，22 个 👍）：摘要只保留“用户提供了 8,200 字符 DOM”这类引用，数据本身丢失；要求附转录索引，并列出 8 个以上同源 issue。
     - #69011（2026-06）：提示说可按 ctrl+o 查看摘要，实际看不到，以 not_planned 关闭。
3. **Codex CLI**
   - 【事实】`codex-rs/prompts/templates/compact/` [S21]：压缩提示把任务定义为“给另一个将接续任务的 LLM 写交接摘要”，内容包括进展与关键决定、约束与用户偏好、剩余步骤、关键数据与引用，要求简洁、结构化。接收侧前缀告诉模型：另一个模型已经开始解决这个问题，请在其基础上继续，避免重复工作。
   - 【推断】这只覆盖了 I-PASS 的 P 和 A，没有接收方综合；而且接收框架偏向“信任前任”。
4. **Cursor**
   - 【事实】论坛长期反馈：自动摘要后上下文丢失，“Summarizing chat context”卡住。工作人员承认摘要有时会丢上下文、触发过早；给出的变通是 @ 旧对话注入摘要、用规则文件、在停顿点手动摘要 [S22，仅摘要]。
5. **VS Code（2026-10）**
   - 【事实】VS Code 把 Copilot、Claude、Codex 称为 agent harness [S23][S24][S25]：
     - 从 Local harness 会话可以经 Session Target 下拉框交接给其他 harness，并携带“对话历史与上下文”；目标端的工具、权限和模型可能不同。
     - Copilot、Claude、Codex 会话只能接收交接，不能再交出（单向）。
     - 企业策略触发的迁移会保留未发送的输入、不自动提交提示，并把原会话存档为只读。
     - 文档没有说明携带的是全文还是摘要，也没有说明能否预览或编辑。
   - 【事实】自定义 agent 的 `handoffs` [S26，原文]：回复完成后出现交接按钮，切到另一个 agent，带上对话上下文和预填提示；默认不自动发送，`send: true` 才会自动提交。
   - 【推断】这是与 HarnessHub 最接近的竞品形态，但它是单向的，而且对用户不说明交了什么。
6. **GitHub**
   - 【事实】Copilot coding agent 以 PR 为交接载体 [S27]：完成后请求你审阅；session log 展示内部独白和工具调用；用 `@copilot` 评论来迭代；请求者本人的批准不计入必需的批准数。
   - 【事实】Agent HQ（2025-10）用 mission control 统一指派和跟踪多家 agent，2026-02 Claude、Codex 进入公测 [S28，仅摘要]。
   - 【事实】PR 中标记为 Viewed 的文件，在之后发生变化时会自动取消 Viewed [S36]。
   - 【推断】这是一种“每个参与者的水位遇到新事实就自动失效”的现成 UX。
7. **Linear AIG**
   - 【事实】Agent Interaction Guidelines [S29]：agent 必须表明自己是 agent；原生地使用平台；立即反馈（沉默导致不确定）；内部状态（思考、等待输入、执行、完成）一眼可见，并可检查推理、工具、提示；被要求退出时立即退出；agent 不能被追责，最终责任在人。
   - 【事实】Issue 只能指派给人，只能委派给 agent [S30，仅摘要]。
8. **OpenAI Agents SDK**
   - 【事实】默认情况下接收方看到完整历史。`nest_handoff_history`（把历史折叠为摘要段）是 opt-in beta，默认关闭；`input_filter` 可以筛选。文档明确提醒：折叠不等于脱敏 [S32]。
9. **Devin**
   - 【事实】长时间不活动的会话进入“睡眠”，之后可以唤醒续接 [S31，仅摘要]。

### 2.7 2025–2026 Agent 交接实证

1. 【事实】Handoff Debt（arXiv 2606.02875 v2，2026-08-30）[S33]
   - **设置**：SWE-bench Verified；75 个源任务、181 个交接点，每个后继模型 724 次接手；后继模型为 Qwen3.6-27B、Gemma-4-31B、Devstral-Small-2。
   - **四种交接视图**：仅仓库状态、原始轨迹、摘要笔记、结构化笔记。
   - **总体结果**：与仅仓库相比，带上下文的交接使中位 agent 事件数减少 20–59%，累计 prompt token 减少 42–63%；对解决率的影响较小，且因模型而异。
   - **“已有行为被破坏”状态**（每视图 n=10，作者称为诊断性数据）：原始轨迹在三个后继模型上都比仅仓库高 40 个百分点（Qwen→Qwen 为 40%→80%）；摘要只高 10–30 个百分点；结构化笔记高 10 个百分点。
   - **三种失败模式**：①紧凑笔记保留了大故事，却丢了确切的验证命令或警告；②后继者过度信任前任的解释；③原始轨迹噪声大。
   - **结构化笔记的字段**：确定性字段（改动状态、改动文件、非源文件产物、最近一次改动后的验证结果、最近验证命令、最近验证证据、续接状态标签）+ 模型生成字段（问题理解、已完成、观察到的证据、失败或错误证据、剩余不确定性、回滚说明、建议下一步）。模型笔记的生成上限为 1,600 token。
   - **接手指令**：把交接材料当作历史笔记而不是事实；以原始任务作为需求来源；先核验，再依赖。
2. 【事实】Handoff Tax（arXiv 2608.24358 v1，2026-08-25）[S34]
   - **设置**：SWE-bench Verified；Claude 与 GPT 各取一对低成本（LC）和高能力（HC）模型。
   - **升级（LC→HC）**：完整轨迹只追回不到一半的质量差距，成本却更高。表 7（Claude 族，LC=Haiku 4.5，HC=Opus 4.7）：

     | 条件 | 通过率 | 成本 |
     |---|---|---|
     | 只用 LC | 60.6% | $0.41 |
     | 只用 HC | 78.8% | $0.72 |
     | 原始轨迹交接 | 69.3% | $1.62 |
     | 原始轨迹 + 声明“前任是不同模型” | 70.5% | $1.67 |
     | 由交出方写摘要（本文据正文推断此对应） | 71.5% | $0.75 |
     | 由接收方写摘要 | 69.6% | $0.98 |
     | 丢弃轨迹、只留磁盘改动 | 72.1% | $0.94 |

   - **降级（HC→LC）**：保留前任轨迹有利，删除会伤质量。也就是说，**最优接口随交接方向反转**。
   - **声明前任是不同模型**：只带来小幅提升，消除不了这笔“交接税”。
3. 【事实】MAST（2025）[S35，仅摘要]：多智能体失败归纳为 14 种模式、3 类（规格问题、智能体间不一致、验证）；不一致类包含“未请求澄清”“任务偏离”等。

### 2.8 HarnessHub 界面与交接现状（本机源码，只读）[S40]

1. 【事实】选择即切换（ADR-015）。composer 下方状态条显示“当前回复结束后自动切换 / 正在保存选择 / 重试切换”；切换失败时通知“未能切换到 X …当前选择仍是 Y”。
2. 【事实】切换生效后，对话里插入“从这里起由 X 接手 · 模型”分隔线，最后一条分隔线带“改回”（ADR-042，`Turn.tsx` 的 `SwitchDivider`，`ChatPage.tsx:241-251`）。
3. 【事实】实际交给 X 的内容由 `buildPublicContext` 生成：一句英文说明加整段 JSON 历史，作为**用户消息正文**发出（`context.ts`；`runtime.ts:1392`）。界面只显示用户原文，不显示实际发出了什么、来源范围、接续等级和省略项。`PublicRun.contextThroughSeq/sourceRunIds` 已被 `api.ts:387-388` 解析，但界面从未渲染。
   【推断】如果用户随后按 ADR-039 去原程序里继续，会在原生转录里看到一大段 JSON 用户消息。这既损害“像原生”，又是“看不见的交接材料”。
4. 【事实】分支和接续本机会话时，界面使用虚线“来源卡”（`BranchOrigin.tsx`）：一行说明原生状态，可展开引用历史。这是可以直接复用的视觉模式。
5. 【推断】上下文用量环（`ChatPage.tsx:238-239`）取的是“最近一个报告了 context 的 Run”，没有按当前执行者过滤。切换到 B 后、B 首轮上报之前（或 B 从不上报时），环上显示的是 A 的占用。该问题未经运行验证。
6. 【事实】`docs/contracts/context-transfer.md`（proposed）已写明：“等级、缺失材料和版本对用户可见”，不得声称原生内部状态被无损迁移。目前尚未实现。

## 3. 模式归纳

**共性**

1. **固定字段与顺序，但效果来自捆绑**：模板之外还需要训练、观察反馈、文化和工具 [S1][S2][S4][S6]。
2. **交接主体来自持续维护的状态面板**（SIA、活的事故文档、日志），交接时只补“截至此刻”的信息和异常 [S8][S10][S6]。在交接时刻凭记忆现写，是公认的失败源 [S8]。
3. **明确的转移时刻，加上“谁在负责”一眼可见**：接管声明、公开宣布、只看棒的位置 [S8][S10][S11][S13][S6]。
4. **接收方是主动的**：先自我简报、扫描日志、评估现状，再提问；接受之前必须解决疑问 [S8][S6][S3]。
5. **转移后有复核或重叠期**：FAA 的复核步骤、任务控制的 1 小时、incident.io 的 20–30 分钟、接力赛的 20–30 m [S8][S6][S12][S13]。
6. **最常丢失的信息**（跨领域高度一致）：
   - 进行中或半完成的危险状态 [S41][S42][S6]；
   - 待回报的结果 [S7]；
   - 应急预案（若…则…）[S3][S7]；
   - 对计划变化的立场与已定决定 [S6]；
   - 带日期的事实 [S2]；
   - 精确的命令与警告 [S33]。
7. **软件侧**：
   - “看不见的摘要”都招致长期抱怨 [S19][S20][S22]。
   - 显式交接普遍采用“可编辑草稿”（Amp 草稿、VS Code 默认不自动发送）[S16][S26]。
   - 但长期运行的产品最终都是“交接 + 压缩 + 按需回查原文”并存 [S17][S19]。

**分歧**

1. **复述**：I-PASS 把接收方综合列为要素 [S3]；Patterson 在四个高后果领域没有观察到 readback，那里依靠的是交互提问 [S6]；Clark & Brennan 的“最小合作代价”认为，“先给一个临时版本，再请对方确认”往往比一次给出完美信息更省力 [S37]。
2. **原始材料还是摘要**：Amp、Claude、Codex 依赖摘要 [S16][S19][S21]；在“破坏状态”下原始轨迹明显更好 [S33]；最优接口随交接方向反转 [S34]。
3. **谁写交接**：
   - 交出方写：Amp、Codex、任务控制的一段话、FAA 规定交出方负责完整 [S16][S21][S6][S8]。
   - 系统从记录生成：SIA、结构化笔记里的确定性字段 [S8][S33]。
   - 以产物为主体：PR、diff [S27]。
4. **可逆性**：VS Code 是单向交接 [S23]；PagerDuty 鼓励多次移交 [S11]；HarnessHub 要求 A→B→A。

## 4. 对 HarnessHub 接力的启示

### 4.1 逐条决定

以下各条都是【建议】。数字是体验侧的目标，需要与性能组的预算对齐。

| # | 决定 | 机制 | 依据 |
|---|---|---|---|
| H1 | **改造后采用** I-PASS + 结构化笔记 | 交接单有 7 个固定字段、固定顺序（见 4.2）。确定性字段占主体；空字段显式写“无”，例如“无未提交改动”，不能省略。每条事实带来源轮次、时间和执行者。 | [S1][S2][S7][S12][S33] |
| H2 | **采用** 持续记录 + 自我简报 | 工作账本在**每轮结算时**增量更新，切换时只投影账本并补“截至此刻”的增量，不调用模型。切换时构建交接单 p95 ≤100 ms；卡片展开 ≤100 ms（感知为即时）。交接因此不依赖交出方 Harness 的“记忆”（它的上下文窗口）。 | [S8][S6][S44] |
| H3 | **采用** 明确的转移时刻，且“只看棒的位置” | 分隔线只在交接单**已送达**后出现，即目标原程序已受理输入（`dispatchedAt`）。在此之前显示“交接中”阶段条。失败时不出现分隔线，并写明“当前仍由 Y 执行”。原生水位按“已送达”推进，不按“已派发”推进（对应简报中 `runtime.ts:1496` 的疑似缺陷）。准备失败时不派发：区外不得起跑。 | [S8][S10][S13] |
| H4 | **采用** 一眼可见的负责人与接续等级 | 分隔线文案扩展为“从这里起由 Codex 接手 · 公共记录接续 · 交接单 #3”。展开后显示“未包含：Claude Code 的内部推理、第 1–8 轮工具原始输出（可按需取用）”。面向用户的等级标签：原生续接 / 原生续接 + 补交 N 轮 / 公共记录接续 / 部分接续（有省略）/ 无法接续（原因）。 | [S6][S29][S40] |
| H5 | **改造后采用** 可编辑草稿；**拒绝**模态确认 | ADR-015 已定为选择即切换，因此不插入确认框。生效后，交接卡片以一行折叠形式出现在 composer 上方，可展开、取消勾选条目、选择交接方式、追加“给接手方的话”。发送时冻结为不可变记录（带 ID 和指纹）。默认零操作。用户的编辑作为来源为 `user` 的派生层，不改原始事实。 | [S16][S26][S40] |
| H6 | **改造后采用** warm 与 cold 两种交接；**拒绝**静默使用模型 | 默认 cold：确定性投影 + 用户原话，始终可用。warm 由用户显式点击“请 Claude Code 写交接说明”触发：交出方 Harness 用其已选模型写 ≤1 段（目标 ≤400 token，硬上限 1,600），事先显示成本，并说明这段请求会写入交出方的原生转录。交出方失败或额度耗尽时 warm 不可用，但不影响交接。 | [S6][S16][S21][S33] |
| H7 | **改造后采用（实验）** 接收方综合 | 不设独立的复述回合（多一回合且有时延；高后果领域也不用 readback）。跨 Harness 的“公共记录接续”时，交接单末尾请接手方在同一回合开头用 ≤3 行写出“接手理解 + 第一步”，约 50–150 输出 token。原生续接且无增量时不加，保持像原生。用户就是 hearback：界面把“交接单要点前 3 条”和这段复述并排显示。**不把复述当作交接成功的证据**（硬约束），只在接力基准里对比开和关时的重做与重复提问次数。 | [S3][S5][S6][S37][S38] |
| H8 | **采用** 交接单中的真相顺序；**改造** Codex 式信任前缀 | 交接单开头声明：材料由 HarnessHub 根据公共记录整理；需求以用户原话为准；文件状态以工作区实际内容为准；工具记录的是尝试而不是结果；叙述只是需要核验的历史笔记。保留“不要重复已完成且已验证的工作”，但去掉无条件“在其基础上继续”的框架，以免助长过度信任。 | [S17][S21][S33] |
| H9 | **采用** 失败与破坏状态置顶 | 上一轮为 failed 或 unknown、测试失败、存在未提交改动时，“状态与风险”字段置顶，并原样附上证据：命令、退出码、末尾约 20 行，受字节上限约束，而不是叙述性摘要。一行提示里用文字标出“上一轮失败”，不只靠颜色。 | [S1][S2][S33] |
| H10 | **改造后采用** 交接方式三档 | 三档：标准（默认）/ 精简（目标、约束、文件状态、失败证据）/ 完整（预算内尽量多给原文）。默认按确定性信号选择：上一轮失败、或刚取消后切换，用“精简”，避免接收方被前任的错误锚定；正常完成用“标准”；超出预算时禁止选“完整”并说明原因。档位只是卡片里的分段控件，不打断用户。 | [S34][S33] |
| H11 | **采用** 按需取用 | 大内容只给引用（ContentRef、轮次、路径），并在卡片上列出“可按需取用：第 1–8 轮工具输出约 X KB”。取用通道由原生通道组决定。读取结果附带“是否已被后续轮次修订或回滚”的标记，防止旧事实覆盖新事实。 | [S2][S6][S17][S19] |
| H12 | **采用** 换回时显示“你离开期间” | A→B→A 时，在分隔线下显示增量卡：“自 Claude Code 上次参与（第 41 条）后，Codex 完成 3 轮：改动 4 个文件（+120/−30），新增 2 项待办，1 次失败”。同一份增量注入给 A。A 看过、B 改过的文件，按 GitHub Viewed 失效的方式标“已被 Codex 修改”。增量为空时显式写“期间无其他执行者的改动”。首条输入是斜杠命令时，必须补交增量或推迟水位。 | [S6][S36][S12][S39] |
| H13 | **采用** 多水位一览 | 详情栏“执行”页新增“接续”小节：每个参与过的 Harness 已送达的水位（第 N 条 / 第 K 轮）、原生绑定状态、最近一份交接单 ID。当前 Run 的 `contextThroughSeq/sourceRunIds` 渲染为“本轮接收：第 a–b 轮公共记录（交接单 #3）”。这也为以后多个 Harness 并行铺路。 | [S6][S29][S40] |
| H14 | **采用** 所发即所见（反对隐形摘要） | 卡片可展开为逐字的“实际发送原文”，与发送内容共用同一个指纹。原生程序里看到的也是这份可读的 Markdown，不再是 JSON。 | [S19][S20][S40] |
| H15 | **采用** 即时反馈与分阶段进度 | 切换后 0.1 秒内出现“交接中”；超过 1 秒显示阶段和已用时间（复用 `RunTiming` 的 `preparingAt/readyAt/dispatchedAt`）；超过 10 秒提供取消。 | [S29][S44] |
| H16 | **保持** 关键活动期间推迟交接 | 维持现行的“当前回复结束后自动切换”，等待时显示在等什么（审批、问题还是工具）；交接中不接受第二个切换（`SWITCH_PENDING`，switching 契约已有）。 | [S6][S40] |
| H17 | **改造后采用** 跨厂商提示 | 某对话**第一次**交给另一家厂商的 Harness 时，一行提示“交接单将发送给 DeepSeek Harness（使用其本机配置的模型）”。若隐去了疑似秘密，显示数量。明确：摘要或折叠不等于脱敏。 | [S32] |
| H18 | **暂缓** 交出方审阅接班者 | 返回 A 时，可以提供“请 Claude Code 先审阅 Codex 的改动”的建议按钮，但不默认执行（有成本，也偏离像原生）。 | [S6] |
| H19 | **采用** 交接疲劳控制 | 默认只显示一行。“需要注意”标记只在有风险信号时出现：unknown、未提交改动、失败、有省略、首次跨厂商。2 分钟内连续多次切换合并显示。 | [S2][S12] |
| H20 | **拒绝** | ①每次交接都弹确认框（违背 ADR-015，诱发疲劳）；②静默自动交接（R05 只能“建议”，由用户确认）[S29][S10]；③把模型复述或自评当作交接成功的证明；④VS Code 式的单向交接 [S23]；⑤只发一份叙述性摘要而丢掉原始证据 [S33][S20]。 | — |

### 4.2 交接单字段（H1 细化，固定顺序）

| 顺序 | 字段 | 来源 | 内容 |
|---|---|---|---|
| 1 | 状态与风险（对应 I） | 确定性 | 最近一轮结果；unknown 的执行（勿重跑）；未结或已取消的审批；未提交改动；仍在运行的后台进程或保留的原生进程；超限与省略 |
| 2 | 目标与约束（对应 P） | 确定性引用 | 用户原话中的目标和约束；用户批准或否决的决定（标出原消息 seq） |
| 3 | 已完成与证据 | 确定性 | 按影响排序的文件改动（+/−，来源轮次）；最近一次验证的命令、退出码、关键错误行（原样） |
| 4 | 待办（对应 A） | 确定性 | 计划条目与待办，带 owner（用户 / 某 Harness / 未指定）和状态 |
| 5 | 注意与预案（对应 S） | 确定性为主 | 失败过的尝试（不要重复什么）；外部改动；若…则… |
| 6 | 来源与水位 | 确定性 | 交接单 ID、throughSeq、源 Run 范围、策略版本、**未包含的内容** |
| 7 | 接棒要求（对应 S，综合） | 固定文本 | 真相顺序（H8）；只继续当前输入；可选的 ≤3 行复述（H7） |

可选的叙述段（H6 warm）作为第 3、5 字段的补充，标明“由 Claude Code（模型 X）在第 N 轮撰写，需核验”。

### 4.3 界面时刻与可见性

| 时刻 | 出现什么 | 默认可见性 | 对“像原生”的影响 |
|---|---|---|---|
| T0 打开选择器（切换前） | 候选项副标题显示预计接续等级与规模，如“公共记录接续 · 约 6k token（窗口 3%）”；后台预取交接单（纯计算，不启动原程序，因为区外不得起跑） | 一行 | 无 |
| T1 选择后、生效前 | 阶段条：等待当前回复结束（在等什么）→ 整理交接单 → 启动 X | 一行状态 | 无 |
| T2 生效后、首条消息前（交接区） | 折叠的交接卡片，如“将随下一条消息交给 Codex · 标准 ▾ · 3 项待办 · 5 个文件 · ⚠ 上一轮失败 [查看]”；可编辑、选档位、追加附言；上下文环显示 B 的**预计**占用（虚线） | 一行；有风险时带标记 | 零操作即默认；不插入模态框 |
| T3 发送 | 用户消息下方小字“附交接单 #3”；交接单冻结 | 一行 | Hub 的界面元素，不进入原生转录 |
| T4 送达与首轮 | 分隔线（送达后才出现）；接手方 ≤3 行复述（仅公共记录接续时）与要点并排显示 | 一行；可展开原文、来源、水位、未包含 | 只有复述这一处轻微偏离原生 |
| T5 首轮结束（复核） | 只在有问题时出现的确定性提示，如“Codex 修改了 Claude Code 未提交改动涉及的 2 个文件”“重跑了标记为勿重复的命令” | 仅有问题时 | 无 |
| T6 换回 A | 增量卡“你离开期间”；被他人改过的文件带标记 | 一行，可展开 | A 收到的是可读的增量，不是 JSON |
| T7 交接失败 | 失败在哪一步、当前仍由 Y 执行、保留的结果与草稿；不出现分隔线 | 显著 | 无 |
| 随时 | 详情栏“接续”：各 Harness 的水位、交接单历史、指纹、策略版本 | 隐藏（在详情栏） | 无 |

**必须可见**：当前执行者、接续等级、省略项、失败与 unknown 标记、首次跨厂商、交接单是否被用户编辑过（例如“已由你移除 2 项”）。
**默认隐藏，可展开**：交接单原文、每条事实的来源 ID、token 估算明细。
**只在详情栏**：指纹、策略版本、原始 JSON 或调试视图。

示意（数字为虚构）：

```
──── 从这里起由 Codex 接手 · 公共记录接续 · 交接单 #3 ────            [改回]
Codex：我接手的理解：修复 test/session.spec 的 2 个失败；不重跑迁移；先跑 npm test。
        └ 对照交接单要点：① npm test 退出码 1（第 12 轮）② 迁移已完成（勿重跑）③ 待办 2 项
```

### 4.4 责任分工与“接棒完成”判据（对应 FAA 的同等责任，以及 agent 不可追责）

- **Hub（交出方的代理）**：负责确定性字段的完整与准确，声明省略项，负责送达与水位，负责失败恢复（掉棒者捡棒：保留原选择和草稿，如实报告）。
- **接手方 Harness**：负责“接受前解决疑问”，可以按需取用；不能被追责。
- **用户**：承担最终责任；可以编辑交接单；是 hearback。
- **接棒完成** = 交接单已送达，且首轮进入 running。在此之前，A 的原生绑定保持不变，“改回”零成本。首轮失败按普通 Run 失败处理，不回滚交接，也不自动重跑。

## 5. 风险与反模式

1. **交接疲劳**：一家教学医院每天可能有 4,000 多次交接 [S2]；HarnessHub 用户也可能频繁换手。每次都弹卡片会让人习惯性忽略，警报疲劳就是类似现象。缓解：H19、默认一行、只在有风险时加标记。
2. **交接单过长**：原始轨迹信息多但无上限、噪声大 [S33]；Amp 的单个 thread 一度达到 2,100 万 token 级别 [S17]。缓解：固定字段、每字段首屏 ≤3 条、大内容只给引用、叙述 ≤1 段。
3. **错误被摘要掩盖**：
   - 紧凑笔记会丢掉确切的命令或警告 [S33]；
   - 在破坏状态下，摘要的帮助远小于原始轨迹（+10–30 对 +40 个百分点，n=10）[S33]；
   - 摘要会只保留“有过这份数据”的引用而丢掉数据本身 [S20 #26771]；
   - 工具调用是尝试而不是结果 [S17]。
   缓解：H9（原样证据）、H11（按需回查原文，并检查后续是否修订）。
4. **过度信任与锚定**：后继者顺着前任的错误路径继续 [S33]；升级时完整轨迹会锚定接收方 [S34]；Codex 的接收前缀鼓励“在其基础上继续” [S21]。缓解：H8、H10。
5. **用户以为接手方知道，其实它不知道**：
   - 发送方与接收方的预期失衡，是交接失败的根源 [S2]。
   - 现有分隔线只写“接手”，暗示接手方完全知情 [S40]；VS Code 也只笼统地说“携带上下文” [S25]；Claude 用户称之为“静默规格漂移” [S20 #21243]。
   - 缓解：H4（等级与“未包含”）、H14（所发即所见）、H12（换回时的增量）。
6. **旧摘要覆盖新事实**：缓解：派生材料不可变且可重建（INV-22）；读取时检查是否已被后续修订 [S17]；水位遇到新改动即失效，同 GitHub Viewed [S36]。
7. **模板主义**：把“有字段”误当成“有质量”。I-PASS 的效果来自捆绑 [S1]；Joint Commission 也明说助记符只是框架 [S2]。缓解：接力基准（重做事件数、重复提问数、遗漏项召回）和真实 Harness 验收，不以 schema 存在为证据。
8. **复述沦为仪式**：LLM 可能自信地复述错；用户也可能不读，即 hearback 失败（空管研究中，复述错误不足消息的 1%，却在运行差错中占相当比例 [S38，仅摘要]）。缓解：复述保持短小、可关闭、与要点并排，且不计入质量证明。
9. **侵蚀“像原生”**：每次切换都往原生转录插入 Hub 文本，复述也改变了原生风格。缓解：原生续接且无增量时不注入；注入内容用可读 Markdown；复述只用于公共记录接续。
10. **用户编辑引入不一致**：例如删掉了失败证据。缓解：原始事实保留在账本；在来源信息中显示“已由你移除 X”；删除风险项时轻量提示，但不阻断。
11. **多人同时交接**：FAA 对合并或拆分岗位要求格外谨慎 [S8]。以后并行多个 Harness 时，必须一次只有一个待决交接，写权唯一。
12. **隐私**：内容跨厂商流动；摘要不是脱敏 [S32]；用户可能不知道 Claude 会话的内容会交给 DeepSeek。缓解：H17。

## 6. 未解决的问题

1. 在同一回合里先写 ≤3 行复述，是否真的能降低 LLM 接手后的重做率？目前没有直接证据，需要在接力基准中做开关对照，并按跨厂商和同厂商分层。
2. 用户能否从交接单中删除失败证据？删除后，接手方是否应被告知“用户移除了某项”？
3. warm 交接让交出方 Harness 写说明，会在交出方原生转录里留下一轮“写交接说明”。是否可以接受？能否改在其原生分支里写（取决于各 Harness 的 fork 能力，由原生通道组核实）？
4. 交接方式的默认值依据“上一轮失败”这类确定性信号，但它不等于“用户因为失败才切换”。是否需要在选择器里加一个轻量的“为什么切换”（可选、可跳过）？
5. “已送达”应如何判定：原程序受理输入即可，还是要等到首个输出？ACP、CLI、App Server 之间的差异需要原生通道组核实。送达状态为 unknown 时，界面和水位应如何表现？
6. 换回时的增量本身过大（例如 B 做了 50 轮）时，增量也需要预算和分层，与交接单共用同一套分层规则？
7. 交接卡片放在 composer 上方还是分隔线处？需要原型和用户测试；本文只给出时刻与可见性。
8. 用户 B（API/SDK 使用方）如何获得同等的可见性？例如在 API 响应和事件里带交接单 ID、接续等级、省略项。
9. Cursor 和 Devin 的当前交接 UX 没有一手资料，结论只来自论坛和二手文章。

## 7. 来源清单

核实方式：**原文** = 打开原文阅读；**仅摘要** = 只看到搜索摘要；**本机** = 本机源码。阅读日期均为 2026-11-02。

| 编号 | 标题 | 作者/机构 | 日期/版本 | URL | 核实 |
|---|---|---|---|---|---|
| S1 | Changes in Medical Errors after Implementation of a Handoff Program | Starmer AJ 等，NEJM 371:1803-12 | 2014-11 | https://pubmed.ncbi.nlm.nih.gov/25372088/ | 原文（PubMed 摘要） |
| S2 | Sentinel Event Alert Issue 58: Inadequate hand-off communication | The Joint Commission | 2017-09-12 | https://digitalassets.jointcommission.org/api/public/content/a05e74ef89484e2084b6511189b73a99 | 原文（PDF） |
| S3 | I-PASS, a Mnemonic to Standardize Verbal Handoffs（含二手要素说明） | Starmer AJ 等，Pediatrics 129(2):201-4；PSNet、WikEM 等 | 2012 | https://psnet.ahrq.gov/issue/i-pass-mnemonic-standardize-verbal-handoffs ；https://wikem.org/wiki/Sign_out_tools | 仅摘要 |
| S4 | Impact of the communication and patient hand-off tool SBAR on patient safety: a systematic review | Müller M 等，BMJ Open 8:e022202 | 2018 | https://pmc.ncbi.nlm.nih.gov/articles/PMC6112409/ | 原文（摘要） |
| S5 | Patient safety after implementation of a coproduced family centered communication programme | Khan A 等，BMJ 363:k4764 | 2018 | https://pubmed.ncbi.nlm.nih.gov/30518517/ | 原文（PubMed 摘要） |
| S6 | Handoff strategies in settings with high consequences for failure | Patterson ES, Roth EM, Woods DD, Chow R, Gomes JO，IJQHC 16(2):125-132 | 2004 | https://www.interruptions.net/literature/Patterson-IntJQualHealthCare04.pdf | 原文（全文 PDF） |
| S7 | Communication failures in patient sign-out and suggestions for improvement | Arora V 等，QSHC 14(6):401-7 | 2005-12 | https://pubmed.ncbi.nlm.nih.gov/16326783/ | 原文（PubMed E-utilities 摘要） |
| S8 | JO 7110.65BB Appendix A: SOP for the Transfer of Position Responsibility | FAA | 7110.65BB（生效日期未在页面核实） | https://www.faa.gov/air_traffic/publications/atpubs/atc_html/appendix_a.html | 原文（curl 获取） |
| S9 | AC 61-115 Positive Exchange of Flight Controls Program | FAA AFS-631 | 1995-03-10（可能已被后续手册取代） | https://rosap.ntl.bts.gov/view/dot/12907 | 仅摘要（扫描件 OCR 与二手资料） |
| S10 | Site Reliability Engineering, Ch.14 Managing Incidents | Google | 在线版 | https://sre.google/sre-book/incident-response/ | 原文 |
| S11 | Incident Commander training | PagerDuty | 在线版 | https://response.pagerduty.com/training/incident_commander/ | 原文 |
| S12 | Async on-call handoff template | incident.io | 2026-08-11 | https://incident.io/blog/async-on-call-handoff-template | 原文 |
| S13 | C1.1 & C2.1 Competition Rules & Technical Rules（Rule 24） | World Athletics | 2026-07-01 修订 | https://worldathletics.org/about-iaaf/documents/book-of-rules | 原文（PDF；子条款编号未能从文本提取） |
| S14 | 接力盲接与目视交接的教练资料 | CoachUp、Wikipedia 等 | 不一 | https://www.coachup.com/nation/articles/relay-handoff ；https://en.wikipedia.org/wiki/Relay_race | 仅摘要 |
| S15 | Warm Handoff guide | AHRQ | 不详 | https://www.ahrq.gov/patient-safety/reports/engage/interventions/warmhandoff.html | 仅摘要 |
| S16 | Handoff (No More Compaction) | Amp（Sourcegraph） | 2025-10-23 | https://ampcode.com/news/handoff | 原文 |
| S17 | Read Bigger Threads | Amp | 2026-07-02 | https://ampcode.com/news/read-bigger-threads | 原文 |
| S18 | Threads（文档） | Amp | 无日期 | https://ampcode.com/docs/threads | 原文 |
| S19 | Explore the context window | Anthropic（Claude Code 文档） | 读取时页面提及 v2.1.198、v2.1.304 | https://code.claude.com/docs/en/context-window | 原文（curl 获取） |
| S20 | anthropics/claude-code issues #667、#21243、#21788、#26771、#69011 | GitHub 用户 | 2025-03 至 2026-07 | https://github.com/anthropics/claude-code/issues/26771 （其余同仓库） | 原文（GitHub API） |
| S21 | codex-rs/prompts/templates/compact/prompt.md、summary_prefix.md | OpenAI（openai/codex） | main @ 18c6dbe52b（2026-11-02）；文件最近一次变更 ba2b67f9cd（2026-06-01） | https://github.com/openai/codex/tree/main/codex-rs/prompts/templates/compact | 原文（raw 文件） |
| S22 | Cursor 论坛摘要相关帖子 | Cursor 用户与员工 | 2025–2026 | https://forum.cursor.com/t/auto-injected-summarization-and-loss-of-context/86609 等 | 仅摘要 |
| S23 | Choose and use an agent harness: Continue with a different harness | Microsoft（VS Code 文档） | 在线版 | https://code.visualstudio.com/docs/agents/run/agent-harnesses | 原文（.md） |
| S24 | Understand sessions and chats | Microsoft（VS Code 文档） | 在线版 | https://code.visualstudio.com/docs/agents/concepts/sessions | 原文（.md） |
| S25 | Tutorial: Hand off work between agents | Microsoft（VS Code 文档） | 页面显示 2026-10-28 | https://code.visualstudio.com/docs/agents/agents-handoff-tutorial | 原文（经抓取工具摘要） |
| S26 | Custom agents: Handoffs | Microsoft（VS Code 文档） | 在线版 | https://code.visualstudio.com/docs/agent-customization/custom-agents | 原文（.md） |
| S27 | Review Copilot PRs；Using the Copilot coding agent logs | GitHub Docs | 在线版 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/review-copilot-prs | 原文（logs 页仅摘要） |
| S28 | Introducing Agent HQ | GitHub Blog | 2025-10-28；2026-02 公测报道 | https://github.blog/news-insights/company-news/welcome-home-agents/ | 仅摘要 |
| S29 | Agent Interaction Guidelines (AIG) | Linear | 活文档（无日期） | https://linear.app/developers/aig | 原文（curl 获取） |
| S30 | Our approach to building the Agent Interaction SDK | Linear | 不详 | https://linear.app/blog/our-approach-to-building-the-agent-interaction-sdk | 仅摘要 |
| S31 | Devin September product update（睡眠与唤醒） | Cognition | 2024-09 | https://cognition.ai/blog/sept-24-product-update | 仅摘要 |
| S32 | Handoffs（Agents SDK Python 文档） | OpenAI | 在线版（未显示版本号） | https://openai.github.io/openai-agents-python/handoffs/ | 原文 |
| S33 | Handoff Debt: The Rediscovery Cost When Coding Agents Take Over Interrupted Tasks | Dipesh KC、Anjila Budathoki | arXiv 2606.02875 v2，2026-08-30 | https://arxiv.org/html/2606.02875 | 原文（HTML 全文） |
| S34 | The Handoff Tax: Continuing Non-Native Trajectories in LLM Agents | Roy Ganz、Mor Shpigel Nacson、Adi Kalyanpur、Ron Litman | arXiv 2608.24358 v1，2026-08-25 | https://arxiv.org/html/2608.24358v1 | 原文（HTML 全文） |
| S35 | Why Do Multi-Agent LLM Systems Fail? | Cemri M 等（UC Berkeley） | arXiv 2503.13657（v3，NeurIPS 2025） | https://arxiv.org/abs/2503.13657 | 仅摘要 |
| S36 | Reviewing proposed changes in a pull request（Marking a file as viewed） | GitHub Docs | 在线版 | https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request | 原文（curl 获取） |
| S37 | Grounding in communication | Clark HH、Brennan SE | 1991 | https://collablab.northwestern.edu//CollabolabDistro/nucmc/ClarkAndBrennan-GroundingInCommunication-1991.pdf | 仅摘要 |
| S38 | Pilot-controller communication errors（readback/hearback） | Cardosi K 等，FAA | 1990s 报告 | https://apps.dtic.mil/sti/pdfs/ADA356655.pdf | 仅摘要 |
| S39 | Determinants of take-over time from automated driving: a meta-analysis of 129 studies | Zhang B 等，Transp. Res. Part F 64:285-307 | 2019 | https://research.tudelft.nl/en/publications/determinants-of-take-over-time-from-automated-driving-a-meta-anal | 仅摘要（仅用于“脱离回路后需重建情境意识”这一定性类比） |
| S40 | HarnessHub 本机源码与契约 | 本项目 | cc/relay-design @ 07a0825 | web/src/components/{Turn,ChatPage,Composer,BranchOrigin,DetailsPanel}.tsx；web/src/api.ts:387-400；src/contexts/session/domain/context.ts；src/contexts/session/application/runtime.ts:1334-1396,1496；docs/contracts/{context-transfer,switching}.md；docs/decisions/0015、0042 | 本机 |
| S41 | Piper Alpha / Cullen 报告的交接与许可证失效（二手） | IChemE、The Chemical Engineer 等 | 不一 | https://www.thechemicalengineer.com/features/piper-alpha-the-disaster-in-detail/ | 仅摘要 |
| S42 | NTSB AAR-92/04 Continental Express 2574 | NTSB/FAA；FSF 1993 | 1992 | https://www.faa.gov/lessons_learned/transport_airplane/accidents/N33701 | 仅摘要 |
| S43 | On-call handover | GitLab Handbook | 在线版 | https://handbook.gitlab.com/handbook/engineering/infrastructure/team/ops/on-call-handover | 仅摘要 |
| S44 | The 3 response time limits | Nielsen Norman Group | 1993 起 | https://www.nngroup.com/videos/3-response-time-limits-interaction-design/ | 仅摘要 |
