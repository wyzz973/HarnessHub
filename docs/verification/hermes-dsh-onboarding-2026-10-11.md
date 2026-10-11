# 接入 Hermes Agent 与 DeepSeek Harness（2026-10-11）

逐项状态以[能力矩阵](native-capability-matrix.md)中 Hermes Agent 与 DeepSeek Harness 两列为准。决定与取舍见 [ADR-031](../decisions/0031-hermes-and-deepseek-harness.md)。

## 交付

- 目录新增两个经审查的原生条目：`hermes`（`hermes acp`，NousResearch/hermes-agent 固定修订）与 `dsh`（`dsh --profile acp`，deepseek-ai/deepseek-harness 固定修订）。界面使用 Hermes Agent 与 DeepSeek 的品牌图标。
- `HermesControl` 处理 Hermes 的 ACP 与规范不一致之处：
  - 恢复只用 `session/load`，因为 Hermes 的 `session/resume` 遇到未知标识会静默新建会话，且响应里没有会话标识可供发现；`session/load` 返回 `null` 视为会话不存在（`NATIVE_SESSION_NOT_FOUND`），不会新建空会话。
  - 文件附件以只读副本路径的文本指针交给它（Hermes 丢弃 `resource_link` 与嵌入资源），由它自己的文件工具读取。
  - 审批：Hermes 在 ACP 模式下 60 秒未得到答复就自行拒绝。Hub 在审批卡片中说明这个期限，提前 2 秒关闭公共请求并提示“审批已超时”，迟到的选择不会被当作已生效。
  - `/model <名称>` 只以固定文本回复、不发 ACP 更新。驱动只在提示词本身就是这条命令时读取它的回复，把新模型记为会话当前模型，因此下一回合沿用，不会被改回（ADR-028）。
- 通用 ACP 层的两处修正（对所有 ACP Harness 生效）：
  - `session/load` 之后的历史回放等待窗口改为从响应时刻开始计算。原来从请求时刻开始，加载较慢（Hermes 需要几百毫秒恢复会话）时等待会被直接跳过，随后到达的回放可能混入下一回合的回复。
  - `session/load` 返回 `null` 统一视为会话不存在。
- 模型目录缓存的配置指纹加入 Hermes（`$HERMES_HOME` 或 `~/.hermes` 下的 config.yaml、.env、auth.json）与 dsh（`$DSH_HOME` 或 `~/.dsh` 下的 settings.yaml、home 级 patch、凭据文件、acp profile 的 patch 与 package.json）。只读取文件身份，不读取内容。
- 发现方式与同类产品一致（审批代理决定）：PATH 与标准安装目录中的官方命令名，非标准安装用发现清单中的显式自定义入口；npm 的 npx 缓存不算安装，有反例测试。Harness 视图为每个控制入口给出入口来源（PATH、标准安装目录、自定义入口、包目录、HarnessHub 管理），不含路径（浏览器状态不含私有命令）；Harness 页把自定义入口标为“自定义入口（发现清单）”，自定义入口不可用时说明原因，未发现时显示已核实的官方安装方式（Hermes、dsh），Hub 不运行它。
- 真实验收脚本：配置未改动检查覆盖两者；新增 `HH_REAL_MANIFEST`（显式发现清单，用于源码构建等非标准安装）与 `HH_REAL_TMP`（临时工作区位置）。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build` 与 `node --test dist/tests/*/*.test.js` | 556 通过、0 失败、0 跳过 |
| 变异检查：临时把回放计时改回从请求开始 | 新测试失败（回复混入“old replayed answer”），恢复后通过；证明测试能抓到原缺陷 |
| `python3 tools/check_design.py --write` 与默认检查 | 通过 |

新增发现测试：npx 缓存中的 `@deepseek-ai/dsh` 副本不会成为安装。新增协议测试：Hermes 慢加载且在响应后回放时回复不被污染；只用 `session/load` 恢复；未知标识返回 `null` 时报会话不存在；接续本机会话时收集响应后的回放；`/model` 只在该命令的回复中被读取；审批期限提示、到期关闭与迟到选择被拒；文件以文本指针发送、图片仍为原生块。目录测试改为 45 个产品、49 个控制入口，并断言两个新条目的入口参数。

## 本机原安装真实证据

Hermes Agent 0.12.0（官方安装方式，`~/.hermes/hermes-agent`，DeepSeek deepseek-v4-pro）；DeepSeek Harness 0.2.1-alpha.1（本机源码构建，经显式发现清单接入；官方分发为 npm 包 `@deepseek-ai/dsh`）。

| 验收 | Hermes | dsh | 证据 |
|---|---|---|---|
| 协议握手（`probe`，不发提示词） | hermes-agent 0.12.0；load、list、fork、resume、图片 | deepseek-harness-acp；list、resume、close，无认证 | `.tmp/cc-hermes-probe.ndjson`、`.tmp/cc-dsh-probe.ndjson` |
| 真实界面两轮对话（独立开发实例） | 第二轮接上上文，回复未混入回放；思考与用量显示 | 第二轮接上上文；上下文占用显示 | 开发实例截图（未入库） |
| 跨 Hub 重启的原生恢复 | 通过 | 通过 | `.tmp/cc-hermes-dsh-resume.json` |
| 思考与回复分开保存（37×43=1591） | 通过，152 字 | 通过，97 字 | `.tmp/cc-hermes-dsh-thinking.json` |
| 工具活动：命令与编辑、详情可读 | 通过（todo、cat、patch 带差异） | 通过（todo_write、bash、read、edit） | `.tmp/cc-hermes-activity.json`、`.tmp/cc-hermes-dsh-activity.json` |
| 文件附件中的暗号 | 通过（文本指针，read 工具） | 通过（resource_link，read 工具） | `.tmp/cc-hermes-dsh-attachments.json` |
| 图片附件 | 受阻：本机模型回复看不到图片 | 未公布图片，Hub 派发前拒绝 | 同上 |
| 原生命令 `/compact` 后仍记得暗号 | 通过 | 不提供命令 | `.tmp/cc-hermes-commands.json` |
| `/model` 改模型后下一回合沿用，显式切换再改回 | 通过 | 不提供命令 | `.tmp/cc-hermes-config.json` |
| 选择推理档位与模型后由原程序回报 | 不提供档位 | 通过（low，所选模型已应用） | `.tmp/cc-dsh-options.json` |
| 分支 | 原生 fork，分支答对暗号且不泄漏到源 | 不支持 fork，按公共历史分支，隔离正确 | `.tmp/cc-hermes-dsh-branch.json` |
| 危险命令审批 | 受阻：本机 Hermes 缺陷，见下 | 受阻：用户预设为 danger-full-access，不发审批 | `.tmp/cc-hermes-approval.json` |

界面检查（独立开发实例）：Harness 页列出 45 个产品、9 个已安装，DeepSeek Harness 显示“v0.2.1-alpha.1 · 自定义入口（发现清单）”。验收用的干净环境里 `hermes` 解析为 `~/.local/bin/hermes`（交互终端 cmux 中另有同名 shim，Hub 服务不经过它）。

所有真实验收都在临时工作区进行，前后核对 `~/.hermes/config.yaml`、`~/.dsh/settings.yaml` 与 acp profile 的 patch 未改动。

## 复核命令

真实验收都在干净环境中运行：`env -i HOME USER LOGNAME SHELL TERM LANG TMPDIR PATH=<~/.local/bin 与系统目录>`，`HH_REAL_TMP` 指向非系统目录，dsh 通过 `HH_REAL_MANIFEST` 指向只含 `dsh-native` 自定义入口的发现清单（`overrides` 指向本机源码构建的 `apps/cli/lib/bin.js`）。证据写入主检出的 `.tmp/`。

| 验收 | 命令（`pnpm build` 之后） | 其他变量 |
|---|---|---|
| 握手 | `node dist/src/cli/control.js probe --harness hermes|dsh --json` | `--manifest <清单>` |
| 原生恢复 | `node --test dist/tests/real/native-resume.real.js` | `HH_REAL_HARNESSES=hermes,dsh` |
| 思考 | `node --test dist/tests/real/native-thinking.real.js` | 同上 |
| 工具活动 | `node --test dist/tests/real/native-activity.real.js` | 同上 |
| 附件 | `node --test dist/tests/real/native-attachments.real.js` | 同上 |
| `/compact` | `node --test dist/tests/real/native-commands.real.js` | `HH_REAL_HARNESSES=hermes` |
| `/model` 同步 | `node --test dist/tests/real/native-config.real.js` | `HH_REAL_CONFIG_OPTION=model`、`HH_REAL_CONFIG_FROM=deepseek:deepseek-v4-pro`、`HH_REAL_CONFIG_TO=deepseek:deepseek-v4-flash`、`HH_REAL_CONFIG_COMMAND="/model deepseek-v4-flash"` |
| 选项与模型 | `node --test dist/tests/real/native-options.real.js` | `HH_REAL_HARNESSES=dsh`、`HH_REAL_MODEL_DSH=["deepseek-official","deepseek-flash"]`、`HH_REAL_OPTIONS_DSH={"reasoning_effort":"low"}` |
| 分支 | `node --test dist/tests/real/native-branch.real.js` | `HH_REAL_HARNESSES=hermes,dsh` |
| 目录 | `node --test dist/tests/real/native-catalog.real.js` | 同上 |
| Hermes 审批 | 一次性脚本：在工作区放一个 `build` 目录，请 Hermes 用终端执行 `rm -rf build`，审批时选“允许一次” | 结果见“发现的问题” |

发现清单的校验错误只含字段名与错误类型（catalog-parser 与 discovery 的错误文本），不含路径。

## 发现的问题

- **Hermes 0.12.0 的 ACP 审批不可用**：`tools/approval.py` 调用审批回调时传入 `allow_permanent`，`acp_adapter/permissions.py` 的回调不接受这个参数（Hermes 自己的 `~/.hermes/logs/errors.log` 记录了 TypeError），失败被当作拒绝，工具输出为“BLOCKED: User denied”，审批请求不会发给客户端。需要用户升级 Hermes；Hub 不替用户升级。
- **Hermes 拒绝写入 `/private/etc/`、`/private/var/`**（file_tools.py 的敏感路径表），而 macOS 临时目录在 `/private/var/folders`。工作区放在那里时，Hermes 会尝试各种绕过办法，一次验收因此用了约 4 分钟，另一次以 `SESSION_BLOCKED` 结束（根因未能复现）。真实用户的工作区不在这些路径；验收改用 `HH_REAL_TMP` 指定的普通目录后，同一验收 29 秒通过。
- 回合结束后 Hermes 不总是在标准输入关闭后自行退出，需要 SIGTERM；清理仍然确认完成。
- 版本显示：选择器中 Claude Code 显示的是 ACP 适配器版本，Hermes 没有版本（`hermes --version` 输出多个版本号并联网检查更新，超过 5 秒）；输入框“本机配置”标签缺少样式（已修）；网页缺少 favicon。

## 未验证与受阻

- Hermes：接续本机会话（它只列出经 ACP 创建的会话，CLI、TUI 与消息网关里的会话不在其中）、子 Agent 嵌套活动、后台进程、导出（原生有 `hermes sessions export`，Hub 未接出）。
- dsh：接续本机会话（不支持 `session/load`，接续时没有历史）、输出图片、子 Agent。
- 读取模型目录会让原程序新建一个空会话：dsh 会持久化并在列表中显示它，Hermes 写入一行但在列表中过滤。处理方式待定（ADR-031）。
- Windows 未验证。
