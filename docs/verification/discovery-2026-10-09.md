# S01 本机检测验证

日期：2026-10-09。范围：只读检测与控制配方，当前宿主 macOS；Node v25.9.0、pnpm 10.12.3、TypeScript 5.9.3。不建立多平台/多发行版兼容承诺。

## 实际执行

- pnpm install --frozen-lockfile --ignore-scripts：锁文件一致，依赖已就绪，无安装脚本运行。
- pnpm test：严格 TypeScript 构建及 21 个领域/真实文件系统/编译后 CLI 测试通过，无跳过。
- python3 tools/check_design.py --write --verify-cache：通过；只允许 catalog-discovery 的所列源码，其他 Session/执行范围仍关闭。68 份固定文件与 6 份官方网页缓存匹配。
- python3 -m unittest discover -s tools -p 'test_*.py' -v：31 个工程检查器接受/拒绝测试通过；新增合法切片、越界源码、无 owner 的切片及进度/延期规则。
- pnpm --silent discover --json：纯 JSON 可解析；8 个内置配方，protocolProbesRun=0。
- 当前宿主实际扫描完成；报告含机器路径，仅保存在被忽略的 .tmp 中，不提交报告正文或用户路径。

## 行为证据

覆盖有序 PATH、有限已知目录、符号链接原始/解析身份、不可执行/目录/坏链接、显式错误不 fallback、原生 CLI 与 Adapter 分开、包装器提供运行时、两者都缺失时不误报安装、自定义条目、重复/未知/超限输入、描述文件大小与 UTF-8、编译后 CLI 的帮助/错误/JSON/自定义配置。

可执行 fixture 带副作用 sentinel；扫描后 sentinel 不存在，证明检测流程没有启动这些候选或查询其版本。没有调用 Harness、读取其登录、调用模型或安装 Adapter。

首次测试发现 fixture 的 /var 与真实 canonical /private/var 路径不同，已按真实 realpath 核对解析目标；未放宽路径断言。另补齐显式 null 配置拒绝、包装器与原生入口均缺失时的分类、空显式目录拒绝。

独立阅读复核发现两处输入边界：原生入口未命中时会漏验相对 adapter override；空 --manifest 会被当成未提供。已改为查找前预检全部显式覆盖路径，以及明确拒绝空描述文件参数，并补齐真实文件系统与编译后 CLI 回归测试。

修复后独立静态复核通过，未发现仍需修复的问题；该复核没有重跑测试，测试结果由主执行者实际运行取得。

本机扫描观察到 7 个原生 CLI 入口、6 个控制入口候选；Claude Code 的 ACP Adapter 未找到，Qwen 未在本次搜索范围内找到。该统计不代表协议、身份或执行验证。

## 未验证

candidate 只是入口和依赖的文件系统观察。没有协议 initialize、认证、真实 prompt、模型、工具、权限或 Session 接续验收。下一步 S02 用这些配方接通握手/事件/关闭，再进入统一对话链路。
