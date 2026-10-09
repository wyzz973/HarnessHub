# S01：只读检测契约

状态：accepted，仅限当前检测切片。输入校验与类型的权威实现见 [领域值与解析](../../src/contexts/catalog/domain/discovery.ts)，应用入口见 [DiscoverHarnesses](../../src/contexts/catalog/application/discover.ts)，配方见 [内置表](../../src/adapters/recipes.ts)。

## 行为

读取网关宿主的 PATH 和有限已知目录，检查候选是普通可执行文件，记录原始入口与解析路径。显式路径覆盖优先，错误时不回退。目录、不可执行文件、坏链接和读取失败不冒充可用入口。

程序安装线索与控制依赖分别记录。控制入口候选可以来自原生 CLI，也可以来自包装适配器；某些配方不要求全局原生 CLI。两者都缺少时不能显示“程序已安装”。

输出 schemaVersion=1，包含 observedAt、各 Harness 的 installation/control 和 protocolProbesRun=0。control.state 的 candidate 只表示启动配方已经解析，不表示已初始化、已登录或可执行任务。probe 始终 not_run。

## 可扩展描述文件

[示例](../../examples/discovery-manifest.json)可追加配方；version 为 1；recipes 与 overrides 可省略但不能显式写成错误类型。id 不能与内置或其他条目重复；override 只能指向已知 Harness，adapter 覆盖只能用于有外部 Adapter 的条目。

binary 和 adapterBinary 是文件名，protocol 是当前已知控制协议，args 是有界字符串数组；不接受 shell 命令串。nativeRequired=false 表示配方可由适配器提供运行时，必须同时有 adapterBinary。这个声明仍需后续协议探测确认。

override.binary/adapter 是绝对路径，在查找任何入口前统一校验，不因某个程序缺失而漏验覆盖值。描述文件至多 64 KiB 且为普通文件，拒绝符号链接与特殊文件；读取时再次限长，UTF-8/JSON/未知字段错误明确失败。

## CLI

构建后使用 pnpm discover；纯 JSON 使用 pnpm --silent discover --json。--manifest 追加描述，--search-dir 追加绝对目录，--path-only 用于复现网关进程环境的搜索范围。

库存扫描成功返回 0，即使某些 Harness 未发现；错误输入/描述文件（含空 --manifest）返回 2。检测不启动候选、不查询版本/登录、不调用模型、不下载包或修改用户配置。真实扫描结果只保存在被忽略的临时目录，不提交用户路径。

## 后续

S02 使用本次解析出的 command 做实际握手、能力探测与关闭，重新核验文件与配置。检测结果是观察，不是启动授权。这里不冻结公共 Session、Provider、执行与切换接口。
