# @harnesshub/core

领域类型、品牌 ID、错误、公共 JSON Schema、IPC 契约与端口接口；不依赖任何其他 HarnessHub 包，第三方依赖只有 `ajv`。内容即原 `src/domain`，在 OSS-004 第 2 步平铺迁入 `src/`，模块规则沿用 [开发规范](../../docs/development.md#模块边界) 中 `domain` 一行。

其他代码按文件导入，不带扩展名：`import type { RunId } from "@harnesshub/core/types";`。导出用通配 `./*`：TypeScript 与 ESLint 经 `@harnesshub/source` 条件直接读 `src/*.ts`，Node 运行时读编译后的 `dist/src/*.js`；取舍见 [ADR 0017](../../docs/decisions/0017-package-layout-migration.md)。
