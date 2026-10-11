# ADR-023：文件、图片与音频输入

状态：accepted，2026-10-11。依据[ADR-020](0020-complete-native-harness-capabilities.md)与[ADR-022](0022-native-activity-and-content-store.md)。用户要求统一聊天界面按各 Harness 实际能力接出文件、图片和音频输入。

## 背景

各原接口接收非文本输入的方式不同：

- ACP 由代理在 `promptCapabilities` 中声明 image、audio、embeddedContext；所有代理都必须接受 `resource_link`。Claude 只把文本资源注入上下文，OpenCode 会自己读取文件链接，Cursor 只读取项目根内的链接，OpenClaw 只转发不超过 5,000,000 字节的图片，其余变成文本。
- Codex 没有文件输入类型，图片和音频由 `localImage`/`localAudio` 指向本地路径，每个模型用 `inputModalities` 声明自己接受什么。
- Pi 的 prompt 只带 base64 图片；模型不支持图片时原程序不报错，而是换成占位文本。
- 代理级声明不等于模型能力：OpenCode 声明图片，但默认模型 big-pickle 看不到图片；OpenClaw 的默认 deepseek-chat 同样不能识图，真实回合中它对一张红色图片回答“蓝色”。

## 决定

1. **上传与暂存。** 浏览器以原始字节 `POST /api/v1/attachments?name=&commandId=` 上传（Content-Length 必填，单个 1 字节到 20 MiB），写入数据根内容存储，记录为本工作区的 upload；声明的图片、音频类型必须与魔数一致，SVG 只算文件。同一 commandId 同内容返回同一引用，内容不同则冲突。`DELETE /api/v1/attachments/:id` 撤回尚未发送的暂存；已随消息发送的内容不受影响。
2. **随输入准入。** 发送接口接受最多 8 个附件 id，单条合计不超过 32 MiB。准入是同步的：附件必须是本工作区未撤回的 upload 且字节仍在，否则不建 Run。附件成为 PublicRun 的不可变字段（Session v7，在 v7 未发布前并入），命令指纹包含附件 id。
3. **派发前检查与复制。** 原生会话打开后、派发前，由 Driver 依据代理声明与所开模型的输入能力检查附件；不接受时本输入以 `ATTACHMENT_UNSUPPORTED`（或 `ATTACHMENT_LIMIT`）失败，Session 保持 open，不产生 unknown。通过检查的附件复制为数据根内的稳定只读副本 `content/files/<id>/<name>`，后续回合原生会话再次读取时仍可用；副本被改动会按摘要恢复，内容被回收时一并删除。
4. **按原接口映射。** ACP：图片、音频为内联块；256 KiB 以内的 UTF-8 文本在声明嵌入上下文时作为嵌入资源，其余为指向只读副本的文件链接。Codex：图片、音频为 `localImage`/`localAudio`，文件以路径写入文本。Pi：图片为 base64，文件以路径写入文本。
5. **模型级输入取自原程序。** Codex 取 `model/list.inputModalities`，Pi 取 `Model.input`，OpenClaw 取 `models.list` 的 `input`，OpenCode 用原 CLI `opencode models --verbose` 的 `capabilities.input` 细化代理声明；读不到时退回代理级声明，不让目录读取失败。模型目录接口返回 `inputs`，界面据此标出不受支持的附件并阻止发送。
6. **界面。** 输入框支持选择、拖放和粘贴文件；附件显示上传状态、大小与不受支持的原因，可移除；已上传的附件随每个对话的草稿保存，刷新后恢复；重试按原附件重发；用户消息显示图片缩略图和可下载文件。
7. **跨 Harness 转移。** 换到没有原生会话的 Harness 时，公共上下文只列出附件的名称、类型和大小，不重发字节。

## 影响

- 只读副本在数据根内、工作区之外。模型主动读取它时，OpenCode 会请求原生“外部目录”审批，由用户在统一界面决定；Hub 不把文件写进用户工作区。
- 数据根需要按内容存储一并备份；回收规则与 ADR-022 相同。
- 未做：音频的真实验收（本机没有声明音频输入的已登录模型）；Claude、Cursor、Gemini 受账号限制只有协议验证；OpenClaw 识图模型的真实投递未验收。

## 否决方案

- 把副本放进用户工作区：可以免去外部目录审批，但会改动用户项目，可能被误提交。
- 只按代理级声明门控：会把图片发给看不见它的模型，得到编造的回答。
- 把文件内容全部内联：大文件和二进制会撑爆单帧，也偏离原程序自己读取文件的方式。

## 验收

见[附件输入验收](../verification/native-attachments-2026-10-11.md)。
