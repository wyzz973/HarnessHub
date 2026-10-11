# 附件输入：文件、图片与音频（2026-10-11）

依据[ADR-023](../decisions/0023-attachment-input.md)。本轮让统一聊天把文件、图片和音频按各 Harness 原接口发送，并在模型看不到某类输入时于派发前明确拒绝。逐项状态以[能力矩阵](native-capability-matrix.md)为准。

## 交付

- 内容存储：upload 暂存（按命令幂等、魔数判型、工作区绑定）、同步准入、撤回、稳定只读副本、随回收删除副本。
- Session v7 的 PublicRun 增加不可变的 `attachments`；发送命令指纹包含附件 id；公共上下文只列附件名称、类型与大小。
- Runtime 在派发前调用 Driver 检查附件并复制，拒绝时本输入 failed 而不是 unknown。
- Driver：ACP 内联图片/音频、嵌入小文本、其余文件链接；OpenClaw 5 MB 与 `models.list` 模型输入门控；OpenCode 用原 CLI `opencode models --verbose` 细化模型输入；Codex `localImage`/`localAudio` 与文件路径；Pi base64 图片与文件路径；各自在模型目录中返回 `inputs`。
- Web：`POST /api/v1/attachments`、`DELETE /api/v1/attachments/:id`，发送接口接受 `attachments`。
- 界面：选择、拖放、粘贴附件；上传状态、大小与不受支持原因；草稿附件随对话保存并在刷新后恢复；重试按原附件重发；用户消息显示缩略图和可下载文件。
- 真实验收脚本 `pnpm test:real:native-attachments`（`HH_REAL_HARNESSES`、`HH_REAL_EVIDENCE`，可选 `HH_REAL_MODEL_<ID>`）。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 514 通过、0 失败、0 跳过；`.tmp/cc-batch3-tests.log` |
| `pnpm web:build` | 通过；主包 507.51 kB，仍略超 Vite 的 500 kB 提示阈值；`.tmp/cc-batch3-webbuild.log` |
| `node --test dist/tests/browser/web.browser.js` | 6 通过、0 失败、0 跳过（新增附件界面测试）；`.tmp/cc-batch3-browser.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：365 个计划场景、189 个能力格、24 个完整格（上一轮 20）；它不运行这些场景；`.tmp/cc-batch3-design.log` |
| `python3 -m unittest discover -s tools -p 'test_*.py'` | 47 通过；`.tmp/cc-batch3-tools.log` |

新增或扩展的测试：内容存储的暂存、准入、撤回、副本修复与回收；v7 附件校验与准入后不可变（变异核验：去掉不可变规则后测试失败）；Runtime 附件准入、派发前拒绝与副本交付；ACP（含音频、嵌入文本、文件链接）、OpenClaw（5 MB 与模型输入）、OpenCode（原 CLI 模型目录细化与退回）、Codex（`localImage`/`localAudio`/文件路径与模型门控）、Pi（图片与 `Model.input` 门控）协议测试；Web 上传、撤回、带附件发送；浏览器附件界面（不受支持的音频阻止发送、刷新后保留、消息显示图片与文件）。拖放与粘贴已实现，浏览器测试只覆盖文件选择。

界面截图 `artifacts/chat-v3/attachments-composer.png` 与 `attachments-sent.png`（被忽略的本地产物）已人工检查，修正了文件附件被拉伸到图片高度的问题。

## 本机原安装真实证据

使用与 4317 服务一致的环境（Homebrew 优先的 PATH、无代理变量），独立临时数据根与工作区。文本附件只含一个随机代码，图片是 64×64 纯红色；判定以回复是否包含附件独有的事实为准。没有触碰 4317 服务、原公共对话或 OpenClaw Gateway 守护进程。

| 验收 | 结果 | 证据 |
|---|---|---|
| Pi（deepseek/deepseek-flash，模型声明图片） | 文本附件：原 read 工具读取副本并回复代码；图片：回复“红色”；原配置不变 | `.tmp/cc-native-attachments-pi.json` |
| Codex（gpt-6.1-sol，模型声明图片） | 文本附件：原程序用 shell 读取副本并回复代码；图片：回复“红色”；原配置不变 | `.tmp/cc-native-attachments-codex.json` |
| OpenCode 默认 big-pickle（模型不声明图片） | 文本附件：回复代码，模型主动读取副本时原程序请求外部目录审批（允许一次）；图片：派发前以 `ATTACHMENT_UNSUPPORTED` 拒绝，Session 保持 open | `.tmp/cc-native-attachments-opencode-openclaw.json` |
| OpenCode mimo-v2.6-flash-free（模型声明图片） | 文本附件从嵌入内容直接回复代码，无工具调用；图片：回复“红色” | `.tmp/cc-native-attachments-opencode-vision.json` |
| OpenClaw 默认 deepseek-chat（模型不声明图片） | 文本附件：桥展开为文本，回复代码；图片：派发前拒绝 | `.tmp/cc-native-attachments-opencode-openclaw.json` |

真实验收发现并修正的问题：只按代理级声明门控时，OpenCode big-pickle 回复“没有收到图片”，OpenClaw deepseek-chat 对红色图片回答“蓝色”（`.tmp/cc-native-attachments-opencode.json`、`.tmp/cc-native-attachments-openclaw.json`）。现在按原程序的模型目录门控，这两种情况在派发前拒绝。

## 未验证与受阻

- 音频：本机已登录的模型都没有声明音频输入，只有协议验证。
- Claude（账号周额度用完）、Cursor（账号套餐限制）、Gemini（客户端被服务端停用）只有协议验证。
- OpenClaw 识图模型的真实图片投递未验收（需要使用其他付费或受额度限制的模型）。
- 未做 Windows 验证；4317 服务尚未部署本轮代码。
