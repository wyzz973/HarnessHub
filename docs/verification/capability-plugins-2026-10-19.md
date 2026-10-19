# 插件启停验收（2026-10-19，第 6a 步）

依据 [ADR-045](../decisions/0045-unified-capability-management.md) 第 9 节、“第 6 步设计”与“审批代理对第 6 步的裁决”。用户要求：“要做到我们的 harnesshub 能够统一的配置和读取”。只在 macOS 上验证。

## 改动

- **新模块**：`src/infrastructure/capabilities/claude-plugins.ts`。Claude Code 的插件模型：已装与账户同步的插件、条目与默认、依赖、管理设置。
- **改动的模块**：
  - `switches.ts`：Claude 与 Codex 的插件开关计划；台账读取认识 `plugin/`。
  - `edits.ts`：
    - 表头按 TOML 规则解析，按段定位标准表，核对“恰好一行”；
    - `setTomlKey` 保留行尾注释、沿用缩进；
    - 修正 CRLF 文件插入新行的位置。
  - `changes.ts`：插件开关的检查（依赖、管理设置、各级覆盖、运行中的进程）；漂移、重新应用、不再跟踪、孤立设置识别插件。
  - `scan.ts`、`capability-reads.ts`：合成行、各家开关与只读原因，按设计第 6 条改正各家的读取。
  - `native-environment.ts`（归 G026）：加可选的 `system` 根目录，让测试读私有目录里的管理设置。
- **接口与页面**：见 ADR-045 第 6a 步实现记录与 [provider-web-mvp](../contracts/provider-web-mvp.md)。插件页上方写明谁能启停；展开插件后每家一个开关。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元 | `node --test dist/tests/unit/*.test.js` | 199 通过，0 失败 |
| 协议 | `node --test dist/tests/protocol/*.test.js` | 144 通过，0 失败 |
| 集成 | `node --test dist/tests/integration/*.test.js` | 407 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 43 通过，0 失败（第一次 42/43，见下） |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G064-P1～P4、G064-R6、G054-CA9 |

- **G064-P1**（单元）：
  - 表头的各种写法与非表头行；多行字符串里的表头不算；子表不算。
  - 原地改值保留行尾注释；缺键时插入一行（CRLF 也对，技能开关的表数组同样适用）；差异恰好一行、改后能解析。
  - 无效样例：点号键、内联表、没有这个插件、非布尔值、同名表两次。
  - 台账：显式 true 写回后删台账；缺键时写明 true 并记台账。
- **G064-P2**（单元）：
  - Claude 停用：原地改，或新增 false。
  - Claude 启用：写回原值（没有条目且默认启用时删掉这一项，文件逐字节回原样）；没有条目而默认停用时写 true；他人写的 false 改成 true。
  - 非布尔条目被拒绝；改动其他键的无效样例被校验拦下。
- **G064-P3**（单元）：
  - 默认值的优先顺序；依赖的并集与三种写法；没有 plugin.json 时市场条目就是清单；依赖带来的启用。
  - 安装目录不存在、市场清单读不到时依赖记为无法核对。
  - 同步插件跨账户去重、代际目录、读不到的清单不带账户 ID；`syncClaudeAiPlugins: false`。
  - 管理设置的层次与覆盖顺序、MDM 描述文件、读不到与非布尔值。
- **G064-R6**（单元）：
  - Claude 与 Codex 的合成行，各自的版本与位置；按默认显示与依赖带来的启用；有条目但未安装；inline 来源；同步插件不含账户 ID；随 Codex 安装与缺省值未核实。
  - OpenCode 的两个目录、点文件、链接、tuple、TUI 插件。
  - Hermes 的 disabled 优先、分类布局、`plugin.yml`、记忆与模型提供方、隐藏目录、缺启用列表。
  - DeepSeek Harness 的 profile；各家的开关与只读原因。
- **G064-P4**（集成，经正式入口，临时家目录，管理设置读私有目录）：
  - Claude：停用一行、提示齐全，再启用后逐字节回原样、没有漂移；依赖两个方向的拒绝。
  - 不提供开关的情况：保留来源、同步、未安装；只读的 Harness 返回 409 `CAPABILITY_UNSUPPORTED`；非法 id 返回 400。
  - 管理设置：主文件、`.d`、MDM 描述文件；检查后文件变了返回 `CAPABILITY_TARGET_CHANGED`。
  - 漂移、重新应用、不再跟踪；孤立设置与清除。
  - Codex：改一行、保留注释与子表，逐字节回原样；缺键的表插入一行、启用写明 true；外部改动进入漂移。
  - 回答里没有凭据与家目录。
- **G054-CA9**（浏览器）：插件页的说明；合成行与两个开关；确认框的差异、生效时机与覆盖；只发送确认的检查；被依赖拦下的检查不能确认；历史。
- **浏览器第一次失败**：G054-CA5 的模拟历史里，孤立设置缺少新增的 `kind` 字段，页面解码失败、没有显示孤立设置。这是测试数据跟不上契约，补上 `kind: "skill"` 后整套 43 个通过；页面对缺字段的回答仍按契约拒绝。
- **变异核对**：
  - 在构建产物里去掉“依赖者”拒绝，G064-P4 在“启用中的 tool@market 依赖它”处失败；
  - 撤回 CRLF 修正并关掉一行核对，G064-P1 失败；
  - 恢复后全部通过。

## 本机只读核对（部署前）

Claude Code 插件模型：
- 18 个用户级安装、5 个账户同步，没有只装在项目里的；
- 清单都读得到，没有插件声明依赖；
- 只有 `superpowers@claude-plugins-official` 停用；没有“有条目但未安装”的条目；
- `swift-lsp@claude-plugins-official` 的条目为 true、默认启用、没有依赖。

Codex：没有设置 `features.plugins`；`swift-lsp` 的表头在第 278 行，第 279 行是 `enabled = true`。

## 第一次真实写入

（待填）

## 未验证与后续

- **往返期间新会话里是否真的少了 swift-lsp**：没有验证，要新建会话。
- **安装与卸载（第 6b 步）**：在本步真机通过后另行设计、送审，第一次真实写入留给用户。
- **Gemini 扩展的启停**：本机 0 个扩展，没有实测，保持只读。
- **平台**：只在 macOS 上验证。
