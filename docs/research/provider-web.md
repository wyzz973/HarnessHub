# Provider 与图形工作台调研

日期2026-10-09。围绕当前用户要求的手动Provider管理/切换与Claude对话+CC Switch配置，使用主来源和本机源码核实；不把网上兼容性表当实际验收。

- [Codex高级配置](https://learn.chatgpt.com/docs/config-file/config-advanced)与[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)：model_provider/base_url/wire_api/env_key；已安装Codex0.160.0及项目既有本地Responses验收。选择生成私有config与per-Turn env，不改个人配置；关闭模型请求重试避免未知重派。
- [Gemini CLI配置](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)：核实最高优先级system settings/API-key认证/模型/自定义Base URL，并读本机安装bundle。ACP newSession重新读取workspace settings，故单改HOME不足。GEMINI_CLI_HOME在不同层语义不一致，首版不用。workspace配置迁移与真实模型调用需要独立证据。
- [OpenCode Provider](https://opencode.ai/docs/providers)与[配置](https://opencode.ai/docs/config)：最新v1/v2与本机行为差异，本机此前SIGKILL仍未通过；首版不受管。
- [CC Switch](https://github.com/farion1231/cc-switch)公开main-en截图用于观察行布局、配置页与密度；[Claude模型设置](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings)核实模型交互。Claude新对话页需登录，未声称最新版逐像素复刻。

采用本机同源HTTP、一次性fragment启动认证、cookie+CSRF、持久快照轮询；没有为美化界面引入虚构模型、随机指标或前端假切换。Provider协议不能从ACP握手推断，注册能力与实际受管配置分开。

## 工具链与依赖

从npm registry核对exact version、engines、peerDependencies，并实际安装后读取package.json许可证；全部锁入pnpm-lock.yaml。Node25.9.0/pnpm10.12.3/TypeScript5.9.3沿用当前宿主；Node最低24。

| 依赖 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| react/react-dom | 19.3.0 | MIT | 图形视图 |
| vite | 8.3.4 | MIT | 生产静态构建 |
| @vitejs/plugin-react | 6.1.2 | MIT | React构建 |
| @types/react / @types/react-dom | 19.3.0 | MIT | 严格前端类型 |
| lucide-react | 1.54.0 | ISC | SVG图标，按需引用 |
| react-markdown | 10.1.0 | MIT | 助手Markdown，无原始HTML执行 |
| @playwright/test | 1.64.0 | Apache-2.0 | 实际浏览器验收 |

安装不执行额外项目install scripts；浏览器验收显式安装匹配Chromium构建1248，运行headless。未创建平台/发行矩阵，未读取个人模型凭据。上游在线页面为本次阅读时版本，配置解释以本机程序和实际验收为准。
