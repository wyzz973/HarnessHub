# 按官网方式安装验收（2026-10-17）

依据 [ADR-044](../decisions/0044-macos-official-channels.md) 第 3 步（按官网方式安装）与审批代理的第四轮裁决。脚本渠道的升级（第 4 步）尚未实现。

## 起因

用户选择了“点击后按官网方式安装”：没装的产品，由 HarnessHub 按官网写明的方式代为安装，先确认，再运行。

## 改动

- 后端：
  - `official-install.ts`：下载安装脚本（只限登记的域名，1 MiB 上限），沙箱里运行，npm 安装精确版本，装完核实。
  - 管理服务新增安装检查、提交和执行，结果未知时可以核实；冻结的安装请求存进管理库 v5。
  - 新接口 `GET /api/v1/harnesses/{id}/install`；`POST /api/v1/installation-jobs` 接受带 `expectedInstallFingerprint` 的安装。
- 产品数据：每个产品的官网安装方式、脚本的登记域名、可写目录、会改的配置文件和程序落点。来源见[渠道调研](../research/official-install-channels-2026-10-17.md)。
- 页面：没装的产品，列表和详情里的“安装”打开安装确认框。完成的任务会列出 shell 配置的改动、设置的改动，以及被阻止的写入。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元与集成 | `node --test dist/tests/*/*.test.js` | 674 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 33 通过，0 失败 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G011-IN1～IN8、G054-IN1 |

新增测试都不碰本机的真实安装：
- 脚本由测试内的假下载提供，但在真实的 macOS 沙箱里运行，装进临时家目录。
- npm 安装连接本机的假 npm 仓库，装进临时前缀，由真实的 npm 执行。

## 未验证与局限

- 还没有在这台电脑上真实安装过。按裁决，第一个由用户点击安装的是 DeepSeek Harness，第二个是 Pi。确认框会说明，装好后终端里的 `pi` 会从开发版改为官网版。
- 四个官方脚本只用测试内的替身验证过，没有运行真正的官方脚本：这台电脑上 Claude Code、Codex、OpenCode、Cursor 都已经装好了，真实运行要等没装它们的电脑。
  - Claude Code 的 `claude install` 实际会写哪些位置，只能真实运行后才知道；写到白名单以外会被阻止，并写在任务里。
- 被阻止的写入是从安装程序的错误输出里找出来的。如果安装程序不打印出错的路径，这里就列不出来。
- 不提供 Homebrew 安装，原因见 ADR-044。
