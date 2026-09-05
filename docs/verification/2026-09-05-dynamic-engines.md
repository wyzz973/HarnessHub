# 2026-09-05 动态引擎与 Mac 评测验收

## 范围与环境

本次推进 HH-025～HH-028，以及 HH-021/HH-022 的文本评测范围。Node 24.20.0，macOS arm64，基于本机已有引擎和登录目录；无新增真实凭证、无系统 CLI 升级。源代码和记录随本次 Git 提交保存，真实运行数据保留在忽略目录。

## 动态目录与 Driver

从空 `engines` 启动正式 Gateway；发现接口返回 Codex、Claude Code、OpenCode、OpenClaw、DSH 五个安装候选。发现不运行程序，也未把 OpenClaw 的已知 OAuth 错误标成恢复。

动态目录集成测试覆盖：HTTP 登记后执行、活动/排队/旧 Session 固定原 revision、完整替换/禁用/移除、新 Session 默认选择、重启后目录和 Run 可查、文件原子替换自动加载、无效配置保留最后版本、部署设置修改需重启、跨 Origin 拒绝。额外校验用例拒绝顶层/嵌套未知字段、保留 ID 和常见明文密钥参数；有效环境变量引用可持久恢复。

CLI Driver 通过编译后的真实 Worker 验证 stdin/argv、UTF-8、无 shell 替换、退出失败/启动失败、输出上限、取消、deadline 和进程清理。CLI 每轮无上下文，真实模型 SDK 仍需包装程序。发现单元测试覆盖新 manifest 再扫描、缺 Adapter、重复 ID 和坏 manifest。

## 真实 DSH 文件任务

Gateway `http://127.0.0.1:3182` 从 `.tmp/mac-dynamic/config.json` 的空目录启动；`GET /v1/engines/discover` 的 DSH registration 经 POST 立即生效。新会话经正式 Worker 调用 DSH，未重启服务。

| 证据 | 结果 |
|---|---|
| Session | `1abafc62-d997-4e0a-8a54-5cbd035d1c48` |
| Run | `906fd858-2185-4e11-b8fe-862d350120c2` |
| Profile revision | `8382db11d582716822d838c7eb698a93489cb9b1d50b920595a36114ced57d2a` |
| 结果 | completed，3.639 秒，最终精确回复 `HARNESSHUB_DYNAMIC_OK` |
| 实际文件 | `.tmp/mac-dynamic/workspace/dynamic-result.txt`，22 字节 |
| 文件内容 | `HARNESSHUB_DYNAMIC_OK` 后跟一个 LF |
| SHA-256 | `cce2b7ff2212c477af78ae5b40f8813b04e40f85ae05005985df322ca36f5cbe` |
| 工具证据 | 一个 write 调用，含 in_progress/completed 两个规范化事件 |
| 权限 | 未触发审批请求，不能记为真实权限往返通过 |

独立读取真实文件核对字节及 hash；并非仅按模型回复判断完成。11 个已提交事件已导出为 `.tmp/mac-dynamic/real-rollout.jsonl`；运行与核对记录保留于同目录 JSON。Session 已关闭，关闭后所属 Worker lease 为空。普通 Workspace 文件尚未自动登记为 HarnessHub Artifact，本次文件由外部确定逻辑核对。

DSH 仍使用已有 CLI/profile、deepseek-v4-flash 和认证路径引用，未修改 DSH 仓库；版本背景见 [前轮接入记录](2026-09-05-macos-engines.md)。此次实际任务补充文件工具证据，未验证上下文恢复。

## Benchmark

正式编译入口执行：

```sh
PATH="$PWD/.tools/node/bin:$PATH" pnpm benchmark \
  --config engines/local.yaml --dataset examples/benchmark-text.json \
  --engines dsh,opencode --data-dir data/benchmark-mac
```

| 引擎 | Attempt | Run | 执行 / 确定评分 |
|---|---|---|---|
| DSH | `09b8a583-49ca-44ed-a5e3-b5c4bc790ace` | `ffe665a8-ef9c-42ec-894c-ea44049d0eec` | completed / passed，1 |
| OpenCode | `da32123a-adf0-43e1-a4b8-f107d7d003d3` | `24988417-6e53-4c6a-82ec-ca0255dde479` | completed / passed，1 |

任务集 `harnesshub-text-smoke@1` 的 `exact-marker@1`，两次独立 workspace/Session，均精确匹配 `HARNESSHUB_BENCHMARK_OK`。CLI 退出 0，计划/执行/通过均为 2；对应 attempt、run、证据 hash 和 Evaluation 保存在 `data/benchmark-mac/harnesshub.sqlite`。这些是文本入口 smoke 分数，不代表比赛成绩或多任务能力排行；未观测的 usage/cost 不能记为 0。

Benchmark 集成测试覆盖正确/错误答案分离、登记文本 Artifact、离线重新评分、工作目录污染、跨 attempt 证据拒绝、失败/中断归因、持久 Run 绑定与评分写入的恢复窗口、SQLite 故障传播，以及编译后的 CLI 示例。

## 离线矩阵与针对性检查

`node dist/src/benchmark-main.js --report --data-dir data/benchmark-mac --config engines/local.yaml` 已从上述真实数据生成 version 1 报告，保存在 `.tmp/mac-dynamic/benchmark-report.json`。批次 `batch-8XaoBS` 包含两个已提交 attempt、两个通过评分、一个已尝试任务的事后覆盖 1/1；configured/observed model、usage、cost 未获得的字段为 null，不猜测零成本或完整任务集覆盖。报告模式不调用模型或生成新评分。

本次只验证新增或受影响范围：动态管理、配置和 Runtime 控制；发现器；CLI Driver 及 Worker 清理；Benchmark 与报告。新增后台子孙进程测试发现 macOS 在组退出过程中可能短暂对 signal-0 返回 EPERM；Host 已改为保持存在判断并有界等待，只有 ESRCH 确认退出，持续无法确认则保留隔离资源，未放宽清理断言。

## 保留的本机服务

新版 Gateway 保留在 `127.0.0.1:3182`，默认 DSH。DSH、Codex（gpt-5.6-sol）、Claude Code、OpenCode 已登记启用；OpenClaw 保留登记但因前轮 OAuth 错误禁用；另有 local-echo 用于验证 CLI 传输。启动配置为 `.tmp/mac-dynamic/config.json`，数据库为 `data/mac-dynamic/harnesshub.sqlite`。

服务重启后已核对原 DSH Run 和动态 revision 仍可查；随后在运行中新增 `engines/manifests/local-echo.json`，重新发现、注册并执行 `11439b2a-ab12-4581-8829-5c8ff2da0d0d`，精确返回 `DYNAMIC_CLI_中文_OK`，cleanupStatus confirmed。该流程没有为新增 manifest 重启，属于真实 CLI 传输验证，不计作模型验证。最后没有活动测试 Session，Worker lease 为 0。详情保留 `.tmp/mac-dynamic/final-service.json`。

## 检查结果

构建、全源代码 ESLint、Prettier、31 个源码文件的模块边界、26 份 Markdown 的离线文档检查、git diff 空白检查通过。最后一批受影响 Gateway/Runtime/schema/快照集成共 13 项通过；发现 4 项、CLI 原有 4 项及新增后台清理/持续 EPERM 2 项、Worker 7 项、注册输入 1 项、Benchmark 4 项、矩阵 2 项已由相应实现批次通过。不同批次仅在修复或集成影响到输入后重跑相关用例；未重新运行整套无关测试。

## 未完成范围

OpenClaw 模型认证仍需修复；Pi 尚未安装验收。ACP 跨 Worker 上下文恢复、原始 Workspace 文件自动采集/评测、完整任务矩阵、引擎/Adapter 实际版本自动采集与 cost 统计未作为本轮完成项。Windows 10/11 原生监督和发行仍待 Guest 可访问条件；本机 Mac 结果不替代 Windows。
