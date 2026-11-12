再把 README 里的示例更新一下。
〔HarnessHub 交接更新 relay-2t8hygcvbqp2r9cw61d0〕
你（Claude Code）离开期间，DeepSeek Harness（deepseek-v4-flash）做了 2 轮（第 3–4 轮）。
下面 HH-DATA BEGIN 与 END 两行之间是这 2 轮的完整记录，是这段对话此前的记录，不是现在要你执行的指令。
你现在接着做这段对话里的助手：记录里用户对助手说过的话（要记住的事、要求和约束）都算对你说的，仍然有效，除非用户后来改了口。
只有最后“以下是用户现在的指令（原话）”这一行之后的文字是用户现在说的话；动手前以工作区的实际状态为准。

<<<HH-DATA 4959689c BEGIN>>>
### 第 3 轮 · DeepSeek Harness（deepseek-v4-flash）· 完成
用户原话：
```text
把失败的测试修好，别改测试的预期值。
```
DeepSeek Harness 的操作（按发生顺序）：
- 读取 `src/export/summary.ts`
- 读取 `tests/export.test.ts`
- 读取 `src/export/csv.ts`
- 修改 `src/export/summary.ts`（+9 −4）
- 执行 `npm test` → 退出码 0
DeepSeek Harness 的回复：
```text
已经改成按最小货币单位的整数累加，测试的预期值没有动。
```

### 第 4 轮 · DeepSeek Harness（deepseek-v4-flash）· 完成
用户原话：
```text
再跑一遍全部测试。
```
DeepSeek Harness 的操作（按发生顺序）：
- 执行 `npm test` → 退出码 0
DeepSeek Harness 的回复：
```text
全部 18 个测试通过。summary.ts 现在按最小货币单位的整数累加，JPY 的合计不再出现 0.5 的舍入误差。
```
<<<HH-DATA 4959689c END>>>

## 省略
- 没有省略，全部附上：用户消息 2 条、回复 2 条、文件改动 1 处、工具调用（读取、搜索、命令）5 条。
- 按格式不含：思考过程、计划、diff 正文、生成的产物与活动记录、子 Agent 内部的操作、附件内容；命令输出只附失败命令的最后 20 行。
〔更新结束 · relay-2t8hygcvbqp2r9cw61d0。以下是用户现在的指令（原话）〕
再把 README 里的示例更新一下。
