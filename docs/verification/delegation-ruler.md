# 委派上下文尺子

量多个 Harness 通过委派协作时上下文传没传到，主线每做完一步（工具能读同一任务里的其他对话 → 任务板 → 去程瘦身）重跑一次，看哪几项由“不过”变“过”。这是量具，不是门禁：“不过”照记，只有场景跑不起来（回合失败、超时、接口出错）或用户的 Harness 配置被改了才让进程失败。代码在 [tests/real/delegation-context.real.ts](../../tests/real/delegation-context.real.ts)。

## 怎么跑

沙箱外、仓库根目录，`pnpm build` 之后（[真实验收手册](../engineering/real-acceptance.md) 第 1 节的 `env.sh` 与 `RUN`）：

```sh
. "$HOME/.cache/harnesshub-acceptance/env.sh"
RUN HH_REAL_MODEL_CLAUDE=haiku node --test dist/tests/real/delegation-context.real.js   # 或 RUN HH_REAL_MODEL_CLAUDE=haiku pnpm test:real:delegation
```

角色 `HH_RULER_A / B / C`（默认 claude / dsh / codex），某家没装或不可用时，用到它的场景记“跳过”；`HH_RULER_SCENARIOS=S1,S4` 只跑这几个；`HH_RULER_LEVEL` 是权限档位（默认 auto）。一轮约 5 分钟。自己起一个 Gateway（端口 0，数据放在系统临时目录、和工作区分开），每个场景一个新工作区，跑完都删掉。结尾打印表格，JSON 证据写到 `~/.cache/harnesshub-acceptance/evidence/delegation-ruler-<时间>.json`，旁边是同名的 `.md` 表格。

## 每个场景量什么

| 场景 | 量的缺口 | 判定 |
|---|---|---|
| S1 约束去程 | 去程能不能带过去早先的约束 | 父对话第 1 轮定下“新建文件以 `zz_` 开头”，第 2 轮聊别的，然后委派“新建一个文件写 hello”：B 新建的文件都以 `zz_` 开头 |
| S2 事实去程 | 1：去程只带文字，不带工具结果 | A 读了 `secret.txt`（里面有随机记号），回复里不说内容；删掉文件后委派 B“查出记号”：B 的回复含记号，B 的工具没碰过那个文件或记号 |
| S3 回程 | 3：回程只有回复文字 | B 新建两个文件，文件名自己起、带随机字母，回复只说“完成”；然后问 A 改了哪些文件：A 不用工具说出两个文件名 |
| S4 兄弟互知 | 4：兄弟对话互相看不见 | B 新建一个随机名文件写 one；再委派 C“在它末尾加 two，从 HarnessHub 的记录里找文件”：那个文件里有 one、two 两行。C 列没列目录另记 |
| S5 不重做 | 去程整段照抄有没有副作用 | A 先建好 `done.txt`（内容 v1），再委派 B 做无关的事：`done.txt` 内容和修改时间都没变，`other.txt` 建好了 |
| S6 Harness 发起时本轮内容 | 2：Harness 自己委派时，子对话看不见进行中的这一轮 | 口令只在 A 这一轮的用户消息里，A 用 `hub_delegate` 交给 B，任务文字里不写口令：B 那一轮结束时，`pw.txt` 里有口令。A 交出的任务里写了口令就记“作废” |
| S7 约束后到 | 5：没有任务级的共同事实 | 委派 B 之后，父对话才定“新建文件以 `qq_` 开头”；再给 B 发一条“再建一个文件”：B 新建的文件以 `qq_` 开头 |
| S8 回程命令 | 3：回程不带子对话跑了什么 | B 运行 `echo RUN-$(openssl rand -hex 4)`，回复只说“完成”；然后问 A 命令输出了什么：A 不用工具说出输出 |

- 结果分五种：过；不过；跳过；作废（量之前的那一步没做成，例如模型没建文件、说出了该藏的内容，这次什么也没量到）；出错。
- 靠工作区外面拿到的不算数：任何一轮里有越出工作区的调用（上级目录、别处的绝对路径、`env`、`curl`、Gateway 数据目录的名字），原本的“过”降为“不过”，“另记”栏列出这些调用。
- “不用工具”里不算 Hub 的清单与收尾两个工具，也不算 Claude Code 的 ToolSearch（它只是加载工具定义）。
- 和交办时的写法有三处不同：S3 的文件名改由 B 自己起，因为任务里写了 `a_child.txt`，回程带回的任务文字里就已经有答案；S2 在委派前删掉 `secret.txt`；另外加了 S7、S8。

## 结果

基线：2026-11-13，尺子提交 `96858a9`，其中产品代码与 `82ee10e` 相同。A = Claude Code 2.1.316（haiku），B = DeepSeek Harness 0.2.1-rc.5，C = Codex 0.166.0，档位 auto。证据见 `delegation-ruler-2026-11-13T04-14-44-422Z.json`；守护核对，用户的配置没有变。

| 场景 | 基线 2026-11-13 | 依据 | 改后第一轮（`2990c83`） | 改后第二轮（加上“原对话里用户后来说的话”与 Codex 工具条目） |
|---|---|---|---|---|
| S1 约束去程 | 过 | B 建了 `zz_hello.txt` | 过 | 过 |
| S2 事实去程 | 不过 | B 用 `hub_turns`、`hub_search` 查了，答“查不到”：记录里只有“读过了” | 过：B 先 `hub_task` 找到原对话，再 `hub_search`、`hub_read_turn` 读到了工具输出里的记号 | 过 |
| S3 回程 | 不过 | 委派结果随这一轮告知了 A，但里面只有任务和“完成”；A 答“不知道” | 过：A 不用工具说出两个文件名（回程带改动的文件） | 过 |
| S4 兄弟互知 | 不过 | C（Codex）调 `hub_task`、`hub_board` 都返回“API route not found”，`hub_turns` 只看得到自己的对话；没加 two，也没列目录 | 过：C 经 `hub_task`、`hub_read_turn` 找到文件并加上 two，没列目录 | 过（线程配置现在总带 Hub 自己的工具条目；它和用户级那一项指向同一个程序，从外面分不出实际用的哪份） |
| S5 不重做 | 过 | `done.txt` 没被动过，`other.txt` 建好了 | 过 | 过 |
| S6 Harness 发起时本轮内容 | 不过 | 子对话里只有任务这一条消息，B 去翻 `env` 和上级目录也没找到，没写 `pw.txt` | 过：B 把口令写进了 `pw.txt`（这一次是 B 自己用工具读到原对话进行中的那一轮） | 过：B 第一轮开头由 Hub 带上了原对话这一轮里用户的话 |
| S7 约束后到 | 不过 | B 第二轮建的是 `world.txt` | 不过：用户补约定时说“这一轮什么都不用做”，A 没调 `hub_remember`，任务板是空的，B 建的还是 `world.txt` | 过：B 第二轮开头带上了任务板和原对话里用户后来说的话，建的是 `qq_world.txt`（这次 A 也调了 `hub_remember`） |
| S8 回程命令 | 不过 | A 只拿到“完成”，说不出命令输出 | 过：A 不用工具说出命令输出（回程带命令与输出末尾） | 过 |

改后两轮都是 2026-11-13 同样的角色与档位，产品代码是主线上“工具按任务读、任务板、去程瘦身、别的对话的改动告知、回程带命令”全部做完之后的。第一轮证据 `delegation-ruler-2026-11-13T04-24-38-684Z.json`；第二轮 `delegation-ruler-2026-11-13T04-30-48-359Z.json`，8 项全过。两轮都只跑了一次，模型输出有随机性；三步改动没有分开各量一轮。

S4 用 C = OpenCode 补量了一次。OpenCode 没有用户级的 harnesshub 一项，用的是这次构建的工具。结果是不过：它的 `hub_turns`、`hub_search`、`hub_read_turn` 只看得到自己的对话，于是去翻了 Gateway 的数据目录（`ls`、`find`，再 `cat` 对话文件），从里面找到 B 的文件名，加上了 two。尺子按“越出工作区”判它不过。证据见 `delegation-ruler-2026-11-13T04-20-30-711Z.json`。

## 量的时候发现的

1. **用户级配置里的 harnesshub 一项指向另一份构建。** `~/.codex/config.toml` 和 `~/.claude.json` 里的 harnesshub 都跑 `relay-stage2-7cb3e9/dist/src/cli/hub-tools.js`。Codex 的适配层见到用户自己有一项同名的、启用着的服务，就保留它，不用 Hub 按会话给的那份（`src/adapters/control/codex.ts` 的 `threadEntry`）。所以 S4 里 Codex 用的是那份构建的工具（多了 `hub_task`、`hub_board`），打到这次的 Gateway 上就是 404。换了构建或升级以后，Codex 的工具就和 Gateway 对不上。Claude Code 同时有两份同名的，用的是哪份没核实。尺子会把这件事写在表格下面。 后来改了：Codex 的线程配置总是带 Hub 自己的那份（只对这条线程生效，不改文件）；用户级那两项还在，Claude Code 两份同名时用哪份仍没核实。
2. **Harness 会到工作区外面找答案。** 第一次跑时，Gateway 的数据目录就在工作区旁边：S6 里 DeepSeek Harness 运行 `grep -rl "口令" ../data/sessions`，找到了父对话的原话，于是被判成了“过”。把数据目录挪到系统临时目录以后，DeepSeek Harness 又去读 `env`（把 `HARNESSHUB_SESSION` 打印了出来）、`~/.dsh/sessions` 和上级目录；OpenCode 则直接找到了挪开以后的数据目录，它是怎么知道这个路径的没查清（在这之前它调过 `list_mcp_resources` 和 Code Mode 的 `search`）。尺子现在把这类做到的都判“不过”。在产品里，Hub 的数据目录和对话记录对同一用户下的 Harness 都是可读的；工具读不到别的对话时，Harness 就会自己去翻。

## 没验证的

- 只按默认角色跑了一轮基线。模型的输出有随机性，单次结果不等于稳定的结论。基线之前另有两次完整运行（第一次的尺子还没修，第二次是误在沙箱里跑的）：S1、S5 三次都是过，S2、S3、S4、S7、S8 三次都是不过；S6 第一次被误判为过，原因见上面第 2 条。
- 其他几家当 A（父对话）的情况没量。Claude Code 实际用的是哪一份 Hub 工具没核实（见第 1 条）。
