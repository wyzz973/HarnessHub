# ADR-015：沿用本机Harness配置、模型发现与直接切换

状态：accepted，2026-10-11。用户明确要求所有接入的Harness使用本机已安装的程序、已有模型配置和登录状态，选择Harness/模型后直接切换，不再单独应用。覆盖此前native模式空HOME的决定。

## 依据

基线49c40b9的真实Codex请求failed，backend已结算/cleanup已关闭，但无error说明；配置configHome=null时，Binding为Codex创建空CODEX_HOME，而本机实际有ChatGPT登录和配置模型。握手通过不代表原生模型请求可用。

2026-10-11读取Multica官方模型来源说明及源码commit `c8d6a1fad03d20a020ca90d1e50257d9f060ee87`：`server/pkg/agent/models.go`、`thinking.go`从真实CLI获取模型；`execenv/codex_home.go`保留共享auth并同步真实配置，不用空目录冒充native。其按模型配置绑定缓存、失败不缓存空列表的做法可参考。只采用机制，不复制其受额外许可条件约束的实现或静态模型目录。

Codex官方app-server的model/list、config/read、account/read与thread/start模型参数是本项目Codex原生模型边界；ACP v1优先读取session/new的category=model配置项，旧安装明确返回models时仅使用实际声明的旧模型接口。以本机实际返回和正式入口验证，不把最新文档替代安装版本证据。

## 决定

- native模式继承本机该Harness的HOME/XDG/专属配置目录、已有登录和必要运行环境，不创建空native配置；选择模型通过原生RPC的运行参数，绝不调用全局配置写接口。显式config-home仍是调用者指定的已有配置来源。用户明确选择独立受管Provider时，保留原来的显式覆盖路径，不能把它当作native默认。
- 只启动已发现的本机/用户显式受管安装，不在发现/执行时下载或换版本。测试注入已有的私有fixture配置来源，与生产native默认区分。
- 本机配置被当前安装版本拒绝时，明确报告NATIVE_CONFIGURATION_INVALID，保留当前有效选择；不能自动执行第三方诊断中建议的doctor --fix、改写全局配置或静默换版本。现场OpenClaw2026.9.9拒绝旧配置，而另一已安装版本握手通过，说明版本和配置兼容性仍须分别验证。
- 模型发现只针对当前选择的控制入口，用相同配置/工作区/二进制读取模型和默认值；认证仅返回ready/missing/unknown及安全说明，无账号详情/密钥。异常/不支持明确返回，不能硬编码静态模型或改用别的Harness。发现有并发/期限/可等待关闭所有者。
- Public selection新增可选nativeModel，与受管provider互斥；每Run固定选择。模型调用失败通过安全code/message关联backend，不能只显示“回复失败”。持久格式v4追加v3→v4迁移，保留旧Run/消息/命令/事件；回退旧程序需旧备份。
- 点击Harness/Provider/模型即提出切换，实时显示正在连接或等待当前回复；无需Apply。快速连续选择由客户端单一所有者只推进最新未提交选择；已受理的切换仍按公共事实收敛，再应用最新选择。新消息只发往最终生效目标，失败保留原有效选择与草稿，不能隐式回退派发。切换不取消活动Run，不转移工具执行。
- 原有blocked恢复需要的未知结果确认仍显式保留，不能借直接切换取消资源边界。关闭和取消的现有契约保持。

## 验证

真实Native Codex读到本机默认模型/登录、模型列表及一次真实回复；至少另一真实ACP入口读取本机模型并通过选模型接口。检查全局配置文件字节未被本项目改写；账号本身的正常登录状态更新不假称隔离。合成模型测试仍覆盖无效模型/跨Harness模型/模型与Provider互斥、错误脱敏、发现失败/关闭、幂等/FIFO/快速改选、状态刷新、原会话历史与自动切换UI、小屏重试按钮不竖排。实际矩阵和未验证组合另记验收，不以43产品目录当全部原生组合通过。
