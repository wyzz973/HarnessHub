# 0003：动态引擎目录与通用 CLI 接入

状态：accepted。日期：2026-09-05。

## 问题

用户要求突破静态引擎列表、修改配置后重启、只支持 ACP 的限制，并优先在现有 Mac 上完成比赛所需执行入口。更新配置时直接替换 Session 使用的 Profile 会改变已接收任务的运行条件。

## 决定

EngineManager 管理当前目录、API overlay、默认选择和历史不可变 revision，在 Gateway 的 SQLite 持久提交后发布。Runtime 经领域端口读当前配置创建新 Session，经固定 revision 执行旧 Session。删除与禁用阻止新会话，旧任务归属保持原样。现有公共状态表与 schema v1 保留，新的 operational catalog 使用独立 version 1 数据。

发现器只检查 PATH、已知安装文件和 JSON manifest；扫描不调用模型、不执行任意程序、不导入插件代码。用户选择候选的注册配置后即可执行；未知引擎通过 manifest 或管理 API 描述，无需穷举系统所有二进制的用途。

通用 CLI Driver 使用 argv + stdin/stdout 接入本机非 ACP 工具或 SDK 包装程序，每轮独立进程和统一事件。CLI 不虚构交互权限、模型选择、历史或恢复能力；每轮结束经 Host 回收进程组，再发布 cleanupStatus。直接 SDK Driver 尚无具体目标，不提前增加任意模块动态导入协议。

配置文件只热更新引擎目录与默认选择。Workspace 和 Runtime 总限额变更需要重启；无效文件保持最后有效状态。API 的 overlay 优先于文件，启动显式默认在合并目录后校验，详细优先级见 [管理说明](../engine-management.md)。

## 替代方案与代价

继续静态配置最省代码，但不能满足运行中增加引擎。让每次 Run 读取最新配置实现简单，却会改变旧 Session 的命令和模型，因此保留 revision 归档。启动后扫描到所有安装并自动启用，会让本机环境变化隐式改变可执行程序范围，因此发现和注册分开，但两者均无需服务重启。

引入完整插件市场和 Native SDK 通用加载器会增加打包、依赖与安全边界；比赛当前通过现成 ACP 与 CLI 包装接入。完整跨引擎续聊、分布式发现和自动任务路由仍是独立需求。

## 验证

必须覆盖空目录启动、API 登记后执行、更新/移除时旧 Session 和排队 Run 不迁移、重启持久化、原子文件保存和无效热加载、manifest 新增发现、CLI 输出/失败/取消/清理。真 Mac 任务独立核对文件或确定答案；发现到安装文件不算模型通过。记录见 [本轮验收](../verification/2026-09-05-dynamic-engines.md)。
