# 通用 CLI 引擎

`driver: cli` 可以接入接受文本输入、向标准输出返回文本的本机命令，不要求实现 ACP。每个 Run 创建一个进程，使用 Session 已登记的工作目录；通过正式 Worker/Runtime 保留事件、期限、取消和执行结果。

## 配置

下面是可执行的本地回显示例，将 `node` 换成本机 Node 的绝对路径可以固定运行版本：

```yaml
engines:
  - id: local-cli
    driver: cli
    command:
      - node
      - -e
      - 'process.stdin.pipe(process.stdout)'
    cli:
      inputMode: stdin
      maxOutputBytes: 4194304
    maxConcurrency: 1
```

`inputMode: stdin` 将 Run 的 `text` 以 UTF-8 原样写入 stdin，随后发送 EOF；不额外增加换行。命令在读完输入之前就关闭了 stdin（已经退出，或根本不读 stdin）时，只是停止写入：写入遇到的 `EPIPE`、`ECONNRESET` 或已销毁的 stdin 不算失败，stdout 仍然读到结束，结果按下文的退出规则判定，Driver 只在私有引擎日志中记一条 `engine.input_closed`。其他写入错误（管道仍然打开，却写不进去）按 `CLI_INPUT_ERROR` 失败并停止进程。需要输入的命令没有拿到输入而以非零退出时，结果是 `CLI_EXIT_NONZERO`。`inputMode: argv` 则要求命令参数中有独立的 `{prompt}` 项，以完整的 Run 文本替换该项。例如：

```yaml
engines:
  - id: local-argv
    driver: cli
    command:
      - node
      - -e
      - 'process.stdout.write(process.argv[1])'
      - --
      - '{prompt}'
    cli:
      inputMode: argv
      maxOutputBytes: 4194304
```

命令以 argv 直接启动，不经过 shell。`{prompt}` 内的空格、换行、引号、反引号和 `$()` 都是参数内容。不会插值嵌在其他字符串中的模板，也不会解析重定向、管道或环境变量。需要特定输入/输出协议的 SDK 或 CLI，可以提供自己的可执行包装程序，再登记它的命令。

实际模型、工具许可和非交互开关由固定的 `command` 参数或引擎自己的配置负责。未使用配置适配器时，Profile 的 `model` 只是记录信息，不自动变成命令参数。显式选择 Cursor/Antigravity 配置适配器时会转换为 `--model`；其他CLI需自己提供原生命令参数。配置值不代表已经观测或验证模型，详见 [独立配置](engine-configuration.md)。凭证通过 `credentialEnv` 声明环境变量名称；不要把密钥写入命令、任务文本或 Profile。

## 输出和结束

标准输出作为 UTF-8 文本流转成 `message.delta`，按 Worker 的持久化确认施加背压，完成后保存拼接文本。UTF-8 多字节字符跨数据块时不会被拆坏。ANSI 控制符、JSON、进度条等都保持原始文本语义；Driver 不猜测原生输出协议，也不猜测编码：命令必须向管道输出 UTF-8。Windows 上不少运行时（未开启 UTF-8 模式的 Python、.NET Framework 控制台程序等）对管道默认使用系统 ANSI 代码页，这类命令的非 ASCII 输出会在 Driver 中变成替换字符，需要由命令自身或其包装程序改为 UTF-8，例如基于 Python 的 Kimi CLI 需要以 Python UTF-8 模式运行。

`maxOutputBytes` 限制 stdout 原始 UTF-8 字节数，默认 4 MiB。超出上限会停止进程并返回 `CLI_OUTPUT_LIMIT`；此前已经提交的片段仍在轨迹中，Run 不会以截断内容假装成功。stderr 不公开、不保存到规范化事件，避免泄露引擎的认证与配置输出。

退出码 0 返回 `completed / process_exit`，只说明命令正常退出；回复内容是否正确由独立评判器判断。非零退出、启动失败、输入写入失败（不是因为命令关闭了自己的 stdin）和异常信号退出分别报告 `CLI_EXIT_NONZERO`、`CLI_SPAWN_ERROR`、`CLI_INPUT_ERROR`、`CLI_PROCESS_SIGNAL`。命令没有读输入就以 0 退出，同样是 `completed`：它说明进程正常结束，不说明输入被采纳。

此前，不读 stdin、很快退出的命令会与 Driver 的写入竞争：繁忙的机器上写入晚于进程退出时，`EPIPE` 被当作 `CLI_INPUT_ERROR`，同时销毁 stdout，已经写出的输出被丢弃；stdin 在写完之前被销毁时，写入回调不再触发，Run 会一直等到 deadline。现在写入在 stdin 的 `close` 与 `error` 时也会结束，不再无限等待。

## 资源和能力边界

Run 的总 deadline 由 Runtime 管理。取消会先向所属 CLI 进程发送 SIGTERM；直接子进程在 250 ms 内未退出时升级为 SIGKILL，并等待退出。Driver 不创建独立进程组。CLI 每轮成功或失败后，Runtime 都先请求 Host 关闭 Worker、核实并清理进程组及[脱离进程组的后代](runtime-api.md#posix-上脱离进程组的后代)，再提交 Run 结果及实际 `cleanupStatus`；取消、deadline 和显式关闭 Session 同样经过 Host 清理。CLI 本身退出、stdout 关闭都不能代替后台孙进程的清理证据。

每轮使用新 CLI 进程；不自动传递上一轮历史，不宣称支持上下文恢复、图片或交互式权限审批。引擎执行本身仍能读写其工作目录和引擎配置允许的资源；进程隔离不等于操作系统沙箱。Windows 的进程树清理与原生命令行为尚未验证。

对应验证位于 [CLI 集成测试](../tests/integration/worker-cli.test.ts)：编译后的 Worker 覆盖 UTF-8 stdin、无 shell argv、失败、输出上限、取消与后代清理，以及不读输入就退出的命令（1 MiB 输入，超过任何管道缓冲）仍保留输出；正式 Gateway 覆盖 deadline，以及父进程正常/非零退出但后台孙进程继续运行时的整组清理与 lease 释放。[CLI Driver 单元测试](../tests/unit/cli-driver.test.ts) 用真实的进程启动器，不依赖机器负载，确定性地覆盖：
- 不读 stdin 的命令以 0 退出保留输出、以非零退出按 `CLI_EXIT_NONZERO` 失败；
- stdin 在写入前被销毁时不再挂起；
- 需要输入却没有拿到的命令以非零退出；
- 管道仍然打开时的写入错误按 `CLI_INPUT_ERROR` 失败。

前两项在修正前分别失败（`CLI_INPUT_ERROR`，以及 8 秒内没有结果）。
