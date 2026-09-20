HarnessHub 便携发行包（Windows）

一、开始使用（全新电脑，不需要联网安装任何东西）

1. 解压到较短的路径，例如 D:\hh。
   包内最长的文件路径接近 200 个字符，用资源管理器的"全部解压缩"解压到"下载"
   这类深目录会超过 Windows 的 260 字符限制并悄悄丢文件。请用 7-Zip，或在
   PowerShell 里执行：  tar.exe -xf harnesshub-*.zip -C D:\hh
   解压不完整时程序会直接报错并说明原因。

2. 双击 Start.cmd。浏览器会自动打开控制台（默认 http://127.0.0.1:3330，
   端口被占用时自动换一个）。窗口保持打开；按 Ctrl+C 结束。

3. 在控制台里填写模型：接口地址（通常以 /v1 结尾）、模型 ID、API Key，保存。
   所有引擎只使用这一个模型，不会用引擎自带的账号、登录或订阅。
   配置完成前提交任务会被直接拒绝（不会启动引擎），提示"未配置统一模型"。

4. 选择引擎，描述任务，开始。任务的文件产物保存在会话的工作目录中。

二、预装的办公工具包

包内 tool-packs\ 下的工具包在首次启动时自动安装到所有兼容引擎，无需操作：
生成和读取 Word / Excel / PowerPoint / PDF、创建会议日程与邮件草稿、打开和
关闭 Windows 应用。在控制台"工具"页可以看到，也可以解除绑定。
设置 HARNESSHUB_PREINSTALL_TOOL_PACKS=0 可关闭自动预装。

三、添加自己的 Skill / MCP / CLI

控制台"工具"页 → 添加工具：选择本机目录（Skill 目录、mcp.json、cli.json），
或直接粘贴 {"mcpServers":{...}} 配置，一次应用到全部引擎。
命令行等价方式：
  .\Install-Tool-Pack.cmd --source "<目录或 JSON 文件>" --engines all
改动在新建的会话中生效。

四、日志与排查

  state\competition-data\logs\gateway.log                请求、会话与任务生命周期、每次模型调用
  state\competition-data\backends\<会话>\diagnostics\engine.log   引擎进程、协议往来、工具调用
  .\Collect-Logs.cmd                                    一键打包全部日志（已脱敏）为 zip
控制台的"执行详情 → 诊断日志"可以直接在页面上查看同样的记录。
需要提示词与回答摘录时，启动前设置 HARNESSHUB_LOG_LEVEL=debug。

五、常见问题

  端口被占用        控制台端口会自动更换；Gateway 端口可用 Start.cmd --port 6218 指定。
  解压不完整        见第一节，改用 7-Zip 或 tar.exe 解压到短路径。
  杀毒软件拦截      把解压目录加入白名单后重新运行；报告"引擎文件缺失"即属此类。
  文件被标记来自网络  PowerShell 执行：Get-ChildItem -Recurse <目录> | Unblock-File
  从其他机器访问     Start.cmd --host 0.0.0.0（该绑定没有鉴权，只能用于隔离网络）。

六、比赛评测入口

评测请按 INSTRUCTION.md 使用 Start-Competition.cmd / gateway.cmd：用环境变量
AGENT_ENGINE 固定引擎，用 HARNESSHUB_MODEL、HARNESSHUB_MODEL_BASE_URL、
HARNESSHUB_MODEL_API_KEY 配置模型，比赛接口在 http://localhost:6217。
详见 README-COMPETITION.txt。

模型 API Key 只存在于进程环境或本机凭据库中；state\ 目录只保存变量名。
运行数据、设置与产物都在 state\ 下；需要干净环境时重新解压一份。
重新分发第三方组件前请阅读 THIRD_PARTY_NOTICES.md 与各厂商条款。

--------------------------------------------------------------------------

HarnessHub portable bundle (Windows) - English summary

1. Extract to a SHORT path such as D:\hh with 7-Zip or `tar.exe -xf`.
   Explorer's "Extract All" into a deep folder exceeds the Windows 260
   character path limit and silently drops files; the bundle then refuses to
   start and tells you so.
2. Double-click Start.cmd. The console opens in your browser
   (http://127.0.0.1:3330 by default, or a free port).
3. Enter the model endpoint (usually ending in /v1), model id and API key in
   the console. Every engine uses only this model - never its own account,
   login or subscription. Until it is configured, Runs are refused up front.
4. Pick an engine and describe the task. Office Tool Packs under tool-packs\
   are installed on first start; add your own on the console's Tools page or
   with Install-Tool-Pack.cmd --source <dir or JSON> --engines all.

Logs: state\competition-data\logs\gateway.log and the per-session
diagnostics\engine.log; .\Collect-Logs.cmd packs both, redacted, into a ZIP.
Evaluation uses Start-Competition.cmd with AGENT_ENGINE and HARNESSHUB_MODEL*
as described in INSTRUCTION.md and README-COMPETITION.txt.
