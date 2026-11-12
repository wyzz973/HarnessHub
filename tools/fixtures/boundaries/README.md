# 边界检查的无效样例

`tools/check-boundaries.mjs`（G063）的无效样例。每个 `.ts` 文件描述几个虚拟源文件：检查必须逐行拒绝其中带标注的违规，并且不得报告没有标注的行。这些文件不会被编译，也不在仓库检查的扫描范围（`src`、`web/src`、`tests`）内。

## 格式

- `// @@ file: <路径>` 开始一个虚拟文件。路径相对于被检查的根目录，决定适用哪些规则；内容到下一个标记或文件结束为止。
- 违规行末尾写 `// expect: B1`，同一行有多条规则时写 `// expect: B1, B10`。行号是虚拟文件内的行号，标记行的下一行是第 1 行。
- 没有标注的行是正例，必须保持干净。它们紧挨着违规写法，用来证明规则没有误伤合法的相邻写法。

## 如何运行

`tests/integration/g063.test.ts` 把每个文件展开成临时目录里的最小文件树，缺少的扫描根补一个空模块，再用去掉全部例外的规则副本运行 `node tools/check-boundaries.mjs --root <临时目录> --rules <副本>`。要求退出码为 1，且报告的“文件:行 规则ID”与标注逐一相同；另外要求规则文件里的每条规则至少在这里有一个样例。

## 样例与规则

| 文件 | 规则 | 内容 |
|---|---|---|
| `domain-imports-child-process.ts` | B1、B2、B4 | 领域层和应用层导入子进程、文件、数据库、HTTP 模块、第三方包和实现层；一个上下文导入另一个上下文 |
| `contract-imports-yaml.ts` | B3、B10 | 契约层导入 yaml、node 模块、实现层和领域层；cli、web、infrastructure、adapters 里出现不该出现或未登记的第三方包 |
| `web-imports-infrastructure.ts` | B5、B6、B7 | 前端引用基础设施、服务端和 node 模块；Adapter 引用 web 和 cli；src 引用 tests 和前端目录 |
| `old-shape-readers.ts` | B11、B12 | `src` 导入把行拼回旧形状的适配器，或对 `store`（含 `app.store`、`this.store`、括号取值）调用 `snapshot()`；不叫 `store` 的 `snapshot`（流的 Hub、数据源）和 `tests` 里的读取不在其内 |
| `test-without-lock-root.ts` | B8、B9 | 测试组合应用、启动 Gateway、启动正式命令时漏传租约目录，传了清单却没配 `--allow-unofficial`；含别名导入、命名空间、promisify 和辅助函数的写法 |

B0（无法解析的文件、缺失的扫描目录、过期的例外、无法归类的导入）由测试直接构造，不在这里。新增规则时在这里补无效样例，没有样例的规则会使测试失败。
