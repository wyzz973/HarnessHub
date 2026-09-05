# 贡献与开发

从 [README](README.md)启动demo，再阅读 [架构](docs/architecture.md)、[AGENTS.md](AGENTS.md)与 [开发规范](docs/development.md)。项目使用严格TypeScript/ESM、Node24.20.0和pnpm10.12.3，依赖版本由单一workspace锁文件管理。

## 修改与验证

- 先检查当前分支、未提交改动和运行进程；不要覆盖别人的工作或共用运行数据目录。
- 按 [TODO](TODO.md)确认范围。新增行为同时处理类型、schema、消费者、持久化兼容和文档。
- 选择 [验证矩阵](docs/testing.md#按变更选择验证)中的相关检查；完整检查用`pnpm check`。
- 修改HTTP接口后运行`pnpm docs:api`并提交生成文件，`pnpm check:api`会拒绝漏记路由、失效源码链接和过期文件。
- 文档需让新读者在没有`.tools/.tmp/engines/*.local.yaml`的环境里理解并启动项目。历史验收记录应说明环境和边界，不代替通用教程。

## 提交与PR

提交应描述具体问题与最终行为，附实际执行的检查和未验证项。设计采纳、代码完成、本地测试、真实引擎、Windows验证分别表述；不把SDK或Agent返回正常当作任务正确性证明。

默认不提交运行数据库、checkpoint、真实轨迹、秘密值、机器本地配置或依赖安装目录。密钥用引用，新增第三方代码保留原许可。不要提交自动下载引擎、隐式改变模型预算或吞掉未知执行结果的兼容路径。

## CI与首次发布

[GitHub Actions](.github/workflows/ci.yml)在Ubuntu运行`pnpm check`，它验证确定的Gateway/SQLite/Worker链路及前端构建；不调用真实模型。macOS Keychain测试仅在Mac适用，Windows另需原生验收。检查失败要定位实际原因，不用跳过、放宽断言或反复重跑掩盖。

发布前检查当前提交和待推送历史中是否混入本机运行数据/凭证，并确认README快速开始可从干净检出运行。检查仓库可见性和目标分支，不默认改写共享历史。GitHub仓库发布不等于npm发布；package.json的private:true用于防止误发npm包。

项目自有代码的开源许可证尚未指定，第三方许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
