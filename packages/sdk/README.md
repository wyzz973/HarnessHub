# @harnesshub/sdk

占位包：OSS-004 第 2 步建立包结构时创建，目前没有任何导出与依赖。它将承载由 OpenAPI 生成的 TypeScript SDK 与手写便捷层，只依赖 `@harnesshub/core`，是 `cli` 与控制台调用 API 的唯一途径，见 [02 第 8 节](../../docs/proposals/oss/02-architecture.md#8-模块与依赖规则) 与 [06 接口与交互面](../../docs/proposals/oss/06-interfaces.md)。在 SDK 生成落地之前不要从这里导入任何内容。
