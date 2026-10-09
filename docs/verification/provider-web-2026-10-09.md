# Provider 与本机工作台验证

日期2026-10-09–10，当前宿主macOS arm64。基线为codex/local-discovery的d16c376，当前变更为ADR-011 Provider/Web切片。旧HarnessHub未修改；完整未来工程门禁保持关闭。此记录描述实际运行结果，不用plan中planned场景代替验收。

## 已交付

- Provider/model独立资源：新增、编辑、启停、不可变revision、命令幂等/CAS、AES-256-GCM vault，历史revision与密钥固定。
- 受管配置：Codex/Responses、Gemini/API-key；私有配置与per-Turn环境。不兼容组合显式拒绝，配置目录与用户全局配置分离。
- 同Session手动Harness/Provider/model切换，旧Run不改写，静止后下一epoch；失败不回退。v1→v2全事务格式迁移保留身份、命令和事件。
- 本机HTTP应用与一次性fragment启动认证、cookie/CSRF、Host/Origin、大小/期限/并发/关闭边界；直接复用真实Store/Runtime/Driver。
- Claude暖白对话与CC Switch式Provider行列表/全页编辑、自有HarnessHub品牌、Harness检测、版本升级、停止/无输出终态、刷新路由续接和移动布局。

## 实际命令与结果

| 命令 | 结果 |
|---|---|
| pnpm build | 严格NodeNext TypeScript通过 |
| pnpm web:build | 严格前端TypeScript/Vite生产构建通过；CSS31.35KB/gzip7.26KB，JS402.52KB/gzip124.45KB |
| node --test dist/tests/*/*.test.js | **318通过，0失败、0跳过**，约6.3s |
| node --test dist/tests/real/*.real.js | **5通过，0失败、0跳过**，约4.9s并行wall时间 |
| pnpm test:web | **1个完整浏览器场景通过，0跳过**，约12.1s；生产资产+真实HTTP/SQLite/Driver/进程，仅外部Harness与模型目录是夹具 |
| python3 tools/check_design.py --write | 设计检查通过；26需求、81任务、298 planned场景；4个获准切片，完整实现门禁false |
| python3 -m unittest discover -s tools -p 'test_*.py' | **33通过**，含web源码越界与嵌套dist绕过反例 |
| git diff --check | 通过 |

Node25.9.0、pnpm10.12.3、TypeScript5.9.3；新依赖exact/许可证见[调研](../research/provider-web.md)。Chromium构建1248（Playwright1.64.0），headless真实渲染。截图在artifacts/web生成，运行数据/截图不入库。

## 证据边界

默认318项包含33项Provider契约/真实SQLite-vault测试、9项控制输出脱敏和14项HTTP集成测试。覆盖unknown字段/UTF8/精确预算、模型所属、禁用、旧revision、CAS/幂等、GCM损坏、链接、dangling关系、超大行、事务触发器拒写、probe重定向/错误/超限/关闭、跨所有delta切分点与重叠key前缀、owner与静止切换。未通过mock自有存储或应用来替代这些事实。

真实程序：Codex **0.160.0**，Gemini CLI实际package **0.62.0**（安装Cellar目录名0.38.2不作为程序版本）。5项分别是既有本地Codex控制、3轮跨两个CLI入口、受管Codex A→B→edited A、受管Gemini、同公共Session **Codex→Gemini→Codex**。

新Codex双Provider验收在第一轮请求到达后编辑A：第1请求仍旧A key/model；下一轮B；再下一轮新A。恰好3次请求，endpoint/model/key逐轮核查；公共历史完整且旧Run revision未改。

跨真实Harness验收恰好3次模型请求：Gemini收到第一轮公共输入与Codex回复；最终Codex收到前两轮公共输入和Gemini回复。公共Session不变，epoch=3，sourceRunIds准确，每轮backend completed与cleanup closed/null protocolFailure分开确认。接续等级是public_context_rehydrate，不是厂商原生resume或内部状态搬运。

本地模型端点使用完整Responses SSE/Gemini SSE生命周期，**没有运行真实云模型**。两种Harness故意跨chunk回显测试key，公开回复、事件、后续上下文及metadata均过滤；密文DB未出现明文key。测试workspace仅keep.txt且内容/目录未改，不能从该空配置workspace结果推断所有既有Gemini项目配置迁移行为。

浏览器从空页面真实操作：新增2个Provider、模型目录probe、A/B切换、编辑空key保留、新revision/model应用、刷新同Session、无输出取消、停用禁止新发送、第三种协议连接保存但Codex选项禁用并有原因、Harness重新检测。IME Enter不派发、Shift+Enter换行、普通Enter发送；无pageerror/非预期consoleerror；另故意丢掉已提交切换的HTTP响应并延迟读响应，显式重试复用同commandId且只生效一个epoch，唯一预期网络错误单独断言。local/session storage无测试key。初始/编辑/列表/聊天/Harness页均检查320和390宽，无页面横向溢出；桌面截图实际审阅。原生option禁用用真实DOM属性与可见原因核实，未把浏览器平台特定End键行为作为产品契约。

## 修正过的具体问题

真实受管配置先暴露macOS /var与/private路径差异，已将临时根canonical化并使用0700目录；初次失败不计通过。审查修正vault/metadata先读后限额、固定文件增长、dangling关系与probe关闭等待。浏览器修正StrictMode重复认证、字段label掺入options/helper、刷新丢当前会话、无输出取消状态不可见、停用目标与旧revision区分；最终检查使用修正后的构建。

## 未验收与后续

自动择优按用户要求不实现；模型代理/账本、成本、完整权限策略、云模型质量、Windows/发行/容量大矩阵仍后续。管理可登记四种协议，当前受管运行只支持上述两种产品组合；其他Harness发现不代表执行/模型配置通过。OpenCode此前SIGKILL未通过，不改口称支持。

同OS用户能访问本机master/env，本版不宣称系统Keychain隔离。显式executable override是用户指定程序，不证明来源/任意wrapper行为；合法manifest不能覆写stock Codex argv/env。正常后端结束不等于用户任务达标，页面使用“本轮结束”。
