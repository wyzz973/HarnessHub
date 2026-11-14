# 对话文件

一个对话就是一个只追加的 JSONL 文件，做法照 Pi。对话的事实只有这个文件，列表、字节范围、事件这些都能从文件重建。代码在 `src/infrastructure/session/session-file.ts`（格式与读取）和 `file-store.ts`（写入）。

## 文件在哪

```
<数据根>/sessions/<工作目录的 slug>/<时间戳>_<对话 id>.jsonl          对话本身：一行头，之后一行一个完成的事实
<数据根>/sessions/<工作目录的 slug>/<时间戳>_<对话 id>.wip.jsonl      进行中日志：回合还没完成的部分，没有进行中的回合时删掉
<数据根>/sessions/<工作目录的 slug>/<时间戳>_<对话 id>.events.jsonl   事件旁路：每次提交的事件，供诊断用，不是事实来源
<数据根>/sessions/<工作目录的 slug>/<时间戳>_<对话 id>.index.json     读取缓存：读到某个大小时的结果（回合的字节范围、计数等），可重建
<数据根>/sessions/index.json                                          列表缓存：每个文件一行，靠大小与修改时间判断是否过期
<数据根>/owner.json · owner.sqlite · relay-log.json · relay-prefs.json  所有者代数 · 操作系统锁 · 首次交接记录 · 接力偏好
<数据根>/trash/                                                       删除就是把一个对话的几个文件挪到这里
```

slug 照 Pi 的写法：`--Users-me-project--`，太长时截断并加摘要。旧的 `gateway.sqlite` 不读也不动。

## 头与条目

第一行是头。之后每一行都带 `type`、`id`（8 位十六进制，按顺序编号）、`parentId`、`timestamp`、`seq`（写这一行的那次提交之后的事件游标）。一行就是一个完成的事实，写下后不再改；同一件事后来变了，就再写一行，读的时候后写的一行为准。不认识的 `type` 跳过，但照样留在文件里。

```
{"type":"session","version":1,"id":"session-…","timestamp":"…","cwd":"/…","createKey":"create-1","parentSession":{"id":"session-…","path":"--…--/…jsonl","entryId":"0000001c"}}
{"type":"session_info",…,"name":"标题"}
{"type":"command",…,"ordinal":1,"command":{"id":"send-1","kind":"send","fingerprint":"…","resultId":"run-…"}}
{"type":"turn",…,"phase":"start","anchor":"00000005","run":{RunRow}}           回合开始；anchor 是这次提交写在哪一行下面
{"type":"item",…,"runId":"run-…","item":{"seq":4,"itemId":"text:1","type":"assistant_message","status":"completed",…,"fields":{…},"text":"完整文字"}}
{"type":"turn",…,"phase":"end","run":{RunRow},"counts":{"userMessages":1,"replies":1,"outputs":0,"changes":0,"calls":2,"unread":1}}
{"type":"turn",…,"phase":"update","run":{RunRow}}                            已结束回合的事后修订（例如确认结果未知）
{"type":"head",…,"head":{"status":"open","epoch":2,"activeRunId":null,"pendingSwitchId":null,"configuration":{…},"selection":{…}}}
{"type":"binding",…,"ordinal":0,"binding":{完整的原生会话绑定，含接力状态}}
{"type":"switch",…,"ordinal":0,"switch":{完整的换 Harness 记录}}
{"type":"relay",…,"packets":[{"runId","packet":{清单},"body":"交接单正文"}],"deliveries":[{送达记录}]}
{"type":"origin",…,"idx":0,"kind":"fork","message":{"role":"user","text":"…"}}  分叉或导入时抄进来的历史
{"type":"leaf",…,"targetId":"0000002a"}                                     当前叶子：切换到另一条分支时写
{"type":"custom",…,"customType":"notice_prints","data":{"prints":[…]}}
```

几条规则：

- 用户消息在被接受时立刻写一行。
- 其它条目在回合结束时各写一行，因为条目的终态往往还不是最后的样子，例如调用的详情是之后的提交才放上去的。
- `head` 只在会变的头状态真的变了时才写。
- 用户改的标题和归档标记记在 `head` 里（`userTitle`、`archived: true`，2026-11-14），改名同时照旧写一行 `session_info`；旧文件没有这两项，就是没改过名、没归档。
- 置顶、稍后提醒、删除、Harness 起的名也记在 `head` 里（`pinned: true`、`snoozedUntil`、`deletedAt`、`harnessTitle`，2026-11-14）；旧文件没有这几项，就是都没有。只改名字和标记的提交写出的每一行带 `"marks": true`，读文件时这些行的时间不算进对话的 `updatedAt`。
- 版本号不落盘，打开对话时取事件游标的值，所以只会增加。

## 树与当前叶子

每一行都靠 `parentId` 挂在上一行下面，整个文件构成一棵树。最后一行就是叶子，当前对话就是从叶子走到根的那条路径。回合（`turn`、`item`）只算路径上的；其余各行（绑定、命令、头、换 Harness、接力）不论写在哪条分支上，都算整个对话的。

- **改发与重试**：在第 k 轮的用户消息上改了再发，或者对它的回复重试，新回合的各行都写在第 k 轮的 anchor 下面。anchor 相同的回合就是同一位置上的几个分支，页面上显示成“‹ 2/3 ›”。
- **切换分支**：写一行 `leaf`，它的 `parentId` 指向那条分支上最新的一行，后面的行接着写在它下面，所以重启后还停在这条分支上。
- **原生会话**：改发、重试或切换分支之后，各个原生会话一律作废；下一轮开新的原生会话，并由接力把当前路径上的历史带过去。
- **回合进行中**：这时不能切换分支，也不能在旧位置改发，会给出明确提示。

## 进行中日志

回合进行中、还没完成的状态写进 `.wip.jsonl`，每次提交追加一行：

```
{"type":"wip","seq":11,"timestamp":"…","runs":[RunRow],"items":[{"runId","item":{不含文字}}],"text":[{"runId","itemSeq","text":"追加的一块"}]}
```

- 回合正常结束：条目与 `turn end` 都写进主文件，然后删掉进行中日志。
- 启动时发现进行中日志：先把它叠到主文件读出的状态上，再交给恢复函数处理。回合记为结果未知，已显示的文字一个字不丢，不会自动重跑；恢复结果写进主文件后，删掉进行中日志。

## 事件旁路与缓存

- **`.events.jsonl`**：一行一个事件，`seq` 写在最前面。`store.events()` 从这里读。它是诊断用的旁路记录，坏了不影响对话本身。
- **`.index.json`**：只在没有进行中回合时写。打开对话时：
  - 缓存与文件的大小、修改时间都一致，就直接用；
  - 文件变长了，而且新增的行是一条链接在缓存末尾之后，就从缓存记下的位置接着往下读；
  - 其余情况整个重读。
- **`sessions/index.json`**：启动时只重读过期或缺失的那几个文件。

## 删除与分叉

- **删除**：把这个对话的几个文件挪到 `trash/`，不做物理删除。
- **分叉成新对话**：把源对话路径上到分叉点为止的历史复制进新文件（`origin` 行）。新文件自成一体，头里用 `parentSession` 记来源（文件路径和分叉点所在行的 id）。
- **导入原生会话**：同样把读到的历史抄成 `origin` 行。
