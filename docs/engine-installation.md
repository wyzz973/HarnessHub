# 本机引擎安装快照

[inspectEngineInstallation](../src/engine/installation.ts)读取 Engine Profile 已固定的启动文件，记录 `source: local-files`、文件 canonical 路径、大小、修改时间、SHA-256 和可获得的 package name/version。组合根显式提供 PATH；检查器不执行引擎或 `--version`，不联网，也不请求模型。

检查范围包括入口可执行文件、`env` 包装之后的实际可执行文件，以及参数中独立出现的绝对 js/mjs/cjs/py/rb/sh/ps1 启动文件。相同 canonical 文件只记录一次。PATH 查找只使用显式传入的绝对目录；相对 executable 路径不能在缺少 cwd 的情况下猜测，明确报错。相对脚本路径只在 `notes` 标记未检查。

环境赋值、参数选项的值和 `--` 后的内容不当作文件读取；例如 HOME、token、`--config`、`--patch` 的文件引用不会进入快照。`env` 支持当前 Profile 使用的环境赋值，以及 `-i`、`--ignore-environment`、`-u`、`--unset` 和 `--unset=...`；无法明确解析的 env 选项拒绝检查。这里不解析 shell 程序，也不声称收集启动时加载的所有模块、插件或 SDK。

每个文件使用 64 KiB 分段读取及流式 SHA-256，单文件上限 512 MiB，合计上限 1 GiB，最多 8 个启动文件。检查前后比较文件身份、大小、mtime、ctime，以及原引用是否仍解析到同一文件；缺失、替换、访问失败和超限明确失败，不能产生成功快照。文件内容不保存在公共元数据中。

package 信息最多从文件所在目录向上查 3 层，遇到 `node_modules` 容器停止。只读取固定名称 `package.json`，上限 256 KiB，并拒绝软链接；只提取 name/version，其他字段不输出。没有包信息时为 null，已有包缺少相应字段时该字段为 null。不从二进制所在的版本号目录推断实际版本。文件 hash 用于精确追溯本机启动材料；实际模型仍须以运行时观测事件记录，不能用安装快照代替。

主要错误为 `ENGINE_INSTALLATION_MISSING`、`ENGINE_INSTALLATION_CHANGED`、`ENGINE_INSTALLATION_TOO_LARGE`、`ENGINE_INSTALLATION_INVALID`。Fake Driver 没有外部入口，返回空文件列表及明确说明。

[聚焦测试](../tests/unit/installation.test.ts)使用真实临时文件验证 Node 文件与包版本、配置/环境引用排除、hash 可重现与内容变化、缺失文件、数量/大小上限、3 层包查找和软链接拒绝。2026-09-05 在 macOS、Node 24.20.0 上执行 `pnpm build`、`node --test dist/tests/unit/installation.test.js`，6/6 通过。尚无 Windows 的 PATH/PATHEXT 原生验收；Windows 配置优先使用显式绝对 executable 路径，并在后续 VMware 验收确认行为。
