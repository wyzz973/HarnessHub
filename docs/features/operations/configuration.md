# 配置

| 项 | 内容 |
|---|---|
| 分类 | 安全与运维 |
| 状态 | 已实现 |
| 验证 | 单元测试（解析、取值顺序、各键的校验与拒绝样例、疑似秘密的拒绝、保留格式的编辑、各平台配置根）与 smoke 测试（编译后的 `hh config` 与 `hh serve` 入口），出站代理的设置另有集成测试；在 macOS arm64 本机通过；Windows 的 `%LOCALAPPDATA%` 路径未在 Windows 上验证 |
| 对照 Magpie | 部分：One `settings.json` for everything 一行有意不同（启动设置在 `config.jsonc`，其余在数据目录）；Portable mode, XDG directories 一行部分（[Packaging and operations](../../magpie-parity.md#packaging-and-operations)） |
| 权威文档 | [配置参考](../../configuration.md)、[07 第 1 节](../../proposals/oss/07-data-security.md#1-数据目录与文件布局) |

## 用途

把 `hh serve` 的启动设置（端口、数据目录、秘密后端、目录刷新、接线、出站代理、网关上限、OTLP 导出等）写在一个带注释的文件里，并能查看每个值从哪里来。provider、Key、Profile 等业务记录与局域网共享、网关功能等运行时设置不在这个文件中。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 通用只读显示版本、数据目录、秘密存储、网关基址与出站代理；不能修改 `config.jsonc` |
| 命令行 | `hh config show [--json]`、`hh config get <path>`、`hh config set <path> <value>`、`hh config unset <path>`，可加 `--config-dir DIR`；`hh serve` 的参数覆盖文件 |
| HTTP | `GET /api/v1/system/info` 的 `network` 给出启动时生效的代理与来源；没有修改配置文件的接口 |

## 已实现的能力

- 位置：配置根下的 `config.jsonc`（macOS `~/Library/Application Support/HarnessHub/config`，Windows `%LOCALAPPDATA%\HarnessHub\config`，其他平台 `$XDG_CONFIG_HOME/harnesshub` 或 `~/.config/harnesshub`）；`--config-dir` 改用另一个目录；文件不存在等于空配置。
- 取值顺序：`hh serve` 的参数 → 文档列出的环境变量（如 `AGENT_ENGINE`、`HH_OFFLINE`、`HTTPS_PROXY`、`NO_PROXY`）→ `config.jsonc` → 默认值；`hh serve` 启动时在 stderr 打印一行 `Config: <文件> (…)`，列出不是默认值的设置及来源。
- 键：`server.host`、`server.port`、`dataDir`、`engines.configFile`、`engines.default`、`secrets.backend`、`toolPackages.root`、`harnessModel.file`、`catalog.autoRefresh`、`catalog.url`、`wiring.autoSync`、`wiring.home`、`network.proxy`、`network.proxyPassword`、`network.noProxy`、`gateway.limits`、`otlp`。
- 校验：`hh serve` 启动与每次 `set`/`unset` 时整体校验；不是带注释的 JSON 为 `CONFIG_UNPARSEABLE`，未知键为 `CONFIG_UNKNOWN_KEY`，非法值为 `CONFIG_INVALID`，看起来像秘密为 `CONFIG_SECRET`；启动以退出码 2 失败，`set` 不写文件，错误指出文件与键路径。
- 拒绝秘密：以 `sk-`、`hhk_`、`ghp_`、`AIza`、`eyJ` 开头的值、`Bearer` 令牌、键名像 `token`、`apiKey`、`password` 的字符串值与 32 字符以上的字母数字混合串都被拒绝，并提示用 `hh credential`；接受秘密的设置写引用 `{"kind": "env" | "file" | "keychain" | "store", "value": …}`。
- `hh config show` 显示每个值与来源（`default`、`file`、`env <变量>`），并在末尾列出运行时设置所在的文件与修改命令；`NO_PROXY` 中不识别的条目给出 WARNING（`--json` 时为 `warnings`）。
- `set` 与 `unset` 用保留格式的 JSONC 编辑器原地修改，注释、顺序与缩进不变；值按 JSON 解析，不是 JSON 时作为文本；`unset` 留下的空对象一并删除；新文件 0600、目录 0700。
- 运行时设置（局域网共享 `gateway-sharing.json`、网关功能 `gateway-features.json`）在数据根下，由 API、控制台与 `hh gateway` 修改并立即生效。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/daemon/src/config-file.ts](../../../packages/daemon/src/config-file.ts)、[packages/daemon/src/config-main.ts](../../../packages/daemon/src/config-main.ts)、[packages/daemon/src/outbound.ts](../../../packages/daemon/src/outbound.ts)（`network` 的取值） |
| 测试 | [packages/daemon/test/config-file.test.ts](../../../packages/daemon/test/config-file.test.ts)、[packages/daemon/test/config-dir.test.ts](../../../packages/daemon/test/config-dir.test.ts)、[tests/smoke/config.test.ts](../../../tests/smoke/config.test.ts)、[tests/integration/outbound-proxy.test.ts](../../../tests/integration/outbound-proxy.test.ts) |
| 决策 | [ADR 0035 出站代理](../../decisions/0035-outbound-proxy.md)；配置根与数据根的划分见 [07 第 1 节](../../proposals/oss/07-data-security.md#1-数据目录与文件布局) |

## 已知限制与未验证

- 守护进程不热加载任何启动设置，修改在下一次 `hh serve` 时生效（例如出站代理）。
- 不在文件中的设置：`HARNESSHUB_LOG_LEVEL`、`HARNESSHUB_RUN_TIMEOUT_MS`、旧的 `HARNESSHUB_MODEL*` 只能用环境变量，`--demo` 与 `--config-dir` 只能用参数。
- `dataDir` 默认是相对当前目录的 `./data`，而不是 07 第 1 节的平台数据根；`HH_HOME` 与便携标记文件未实现。
- Windows 上的配置根与文件权限未在 Windows 上验证。

## 优化候选

- **现状**：日志级别与 Run 超时只能用环境变量设置。**方向**：在 `config.jsonc` 中增加对应的键，保持环境变量优先。**依据**：[配置参考：不在配置文件中的设置](../../configuration.md#不在配置文件中的设置)（“配置文件尚未接管”）。
- **现状**：数据根默认随当前目录变化，配置根却按平台固定。**方向**：数据、日志、缓存也按平台约定定位，并支持 `HH_HOME` 把四类根目录放在一处。**依据**：[07 第 1 节](../../proposals/oss/07-data-security.md#1-数据目录与文件布局)、[对照表](../../magpie-parity.md#packaging-and-operations) Portable mode 一行（部分）。
- **现状**：改出站代理等设置都要重启守护进程。**方向**：评估哪些设置可以安全地在运行中重新读取（如 `catalog.*`、`network.*`），并在 `hh config set` 输出中说明是否需要重启。**依据**：[配置参考：出站代理](../../configuration.md#出站代理)“查看”一条与 `hh config` 一节。
