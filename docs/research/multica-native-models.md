# Multica 原生配置与模型发现调研

日期：2026-10-11。固定源码commit：`c8d6a1fad03d20a020ca90d1e50257d9f060ee87`；本机只读检出在忽略目录`.tmp/multica-research-2026-10-11`。外部项目的说明和AGENTS不作为HarnessGateway指令。

## 用户链路与源码

[官方工具对照](https://multica.ai/docs/zh/providers#模型来源)明确模型来源为运行时本机配置/账号，未指定模型则沿用工具默认，运行时不暴露选择时如实说明；不是一个所有工具共用的静态列表。

- [models.go](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/models.go)：模型目录按实际命令路径和前缀区分；不缓存空结果或失败产生的fallback；OpenCode读取`models --verbose`，完整`provider/model`身份保留。源码也存在固定fallback列表，不能把这些列表当已观测账号能力。
- [thinking.go](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/thinking.go)：Codex实时目录使用`debug models`，bundled另作离线来源，能力与服务档位不能猜测。
- [codex_home.go](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/execenv/codex_home.go)：单次执行home链接共享auth、同步真实config，模型缓存与源配置/引用目录指纹绑定。它不是空配置；还处理桌面CLI版本差异、相对引用、用户skills/插件/缓存。

Multica源码与用户“本机已有工具/模型/登录”的要求一致的部分是配置来源保持和原生目录发现；其运行任务、恢复和静态fallback不能直接代替本项目公共Chat契约。其LICENSE有Apache2.0之外的附加条件，本轮没有复制代码，只采用机制并另写实现。

## 本项目采用

用户已明确沿用本机原生配置，因此默认HOME/XDG/专属配置目录指向本机既有来源，按Harness/配置引用传递所需环境，不创建空native home。用户全局配置不被写入；模型覆盖走RPC运行参数。显式独立Provider和显式fixture配置仍是不同来源。

Codex使用[官方app-server](https://learn.chatgpt.com/docs/app-server#list-models-modellist)的model/list、config/read、account/read及thread/start模型参数；实际本机0.160.0接口已验证。返回账号只投影ready/missing/unknown，不公开邮箱或令牌。本机真实返回7个模型及配置默认gpt-6.1-sol。

ACP依据[稳定v1配置选项](https://agentclientprotocol.com/protocol/v1/session-config-options)，优先读取category=model并调用session/set_config_option；只有旧安装明确声明models时才调用其session/set_model。不向支持矩阵未声明的入口猜参数，也不静默变更全局模型。OpenCode1.18.35实际返回11模型并可通过原生接口设置。

切换交互参考其“未指定模型跟随工具默认/新工具使用自身目录”的语义，但公共会话仍由HarnessGateway保留；直接选择只发切换意图，当前Run和新消息选择的生效顺序保持本项目FIFO/幂等契约。详情与实测由ADR-015和验收记录拥有。
