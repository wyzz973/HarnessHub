# 离线发行文件与分片恢复

[归档工具](../scripts/archive-offline.py)把已准备完成的 Windows 发行目录转换成可上传的离线资产。它使用 Python 标准库，不下载或安装依赖，不启动模型。发行目录必须带有与实际文件完全一致的 `bundle.json`，并已停止服务、移出运行状态。Windows 端用 [Restore-Offline.ps1](../distribution/Restore-Offline.ps1)校验和恢复，不需要安装 Python。

## 在开发机创建归档

使用已有 Python，传入明确的绝对路径；ZIP 输出必须位于发行目录外，目标 ZIP、同名分片和 manifest 均不能已存在：

```powershell
python -I -B scripts/archive-offline.py create --bundle "C:\release\HarnessHub-win32-arm64" --zip "C:\deliveries\HarnessHub-Windows-ARM64.zip"
```

工具检查实际文件集合与 `bundle.json` 完全一致，逐文件核对大小和 SHA256，然后生成包含一个根目录的 ZIP64 归档。ZIP 成员顺序、时间戳、文件属性与压缩级别固定；同一 Python/zlib 环境下相同输入字节产生相同 ZIP。不同压缩库版本仍以本次输出记录的精确 SHA256 为准。

它拒绝 `state/`、`.incomplete`、文件树中的符号链接和 Windows reparse point，以及 `.env*`、DPAPI、SQLite、账号凭证、SSH 私钥等已列明的敏感文件。内容检查拒绝 PEM 私钥材料。可对本次测试实际使用的密钥补充精确检查，命令只传环境变量名：

```powershell
python -I -B scripts/archive-offline.py create --bundle "C:\release\HarnessHub-win32-arm64" --zip "C:\deliveries\HarnessHub-Windows-ARM64.zip" --secret-env DEEPSEEK_API_KEY
```

该变量必须已经存在且至少 8 个字符；工具检查其 UTF-8、UTF-16LE 字节，跨读取块也能发现，不在日志或 manifest 中保存值。可以重复使用 `--secret-env` 检查多个已知凭证。上述检查不推断任意字符串是否为秘密，也不递归解包 ZIP 内嵌的第三方归档；发行目录仍应来自干净的打包流程，不能直接复制个人账号目录。

## 生成的文件

每个归档生成一个 `HarnessHub-Windows-ARM64.offline.json`，记录完整 ZIP 大小/SHA256、内部 `bundle.json` 的 SHA256、有序资产清单，以及本次逐成员验证结果。

- ZIP 小于 2 GiB 时，资产为一个 `.zip` 文件。
- ZIP 达到 2 GiB 时，资产为 `.zip.part001`、`.zip.part002` 等分片，每片最多 1,932,735,283 字节，即向下取整的 1.8 GiB。
- 每片均记录索引、严格文件名、大小和 SHA256；全档 SHA256 独立记录。分片模式不发布超过限制的完整 ZIP。
- 工具重新读取最终资产、重组 ZIP，并再次读取 ZIP 中每个文件核对大小和 SHA256 后，才最后写出 `.offline.json` 完成标记。

上传 Release 时包含 manifest、manifest 的 `parts` 数组列出的全部文件，以及本仓库的 `Restore-Offline.ps1`。恢复脚本可通过仓库代码或同次 Release 获取；归档工具不会自动上传 GitHub，也不会改变账号设置。准备归档时峰值临时磁盘空间约为完整 ZIP 的 3 倍，除此之外还需保留原发行目录。

## Windows 内网校验与恢复

将 manifest、全部分片或单个 ZIP、`Restore-Offline.ps1` 放在同一目录。选择一个尚不存在的输出 `.zip`，例如：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Restore-Offline.ps1 -Manifest .\HarnessHub-Windows-ARM64.offline.json -OutputZip .\HarnessHub-restored.zip
Expand-Archive -LiteralPath .\HarnessHub-restored.zip -DestinationPath .\HarnessHub
```

`-ExecutionPolicy Bypass` 只对该 PowerShell 进程生效，不更改机器或用户的执行策略。脚本兼容 Windows PowerShell 5.1 和 PowerShell 7，使用系统 .NET ZIP/SHA256 能力，不连接网络。脚本先验证全部分片、重组后的完整 SHA256，再打开 ZIP，核对清单、所有成员、文件大小和每个文件 SHA256；成功后才把临时文件发布为指定输出。

缺少分片、多余分片、索引乱序、文件名不符、大小或散列错误、链接、ZIP 内额外文件、路径越界、成员损坏以及已有输出目标都会返回非零。失败时不会覆盖原目标，自己的 `.incomplete` 文件会清理。恢复需要额外容纳完整 ZIP 的磁盘空间；解压还需要容纳发行目录。仅在恢复脚本退出 0 后解压并按发行包说明启动。

已有 Python 的开发机也可独立检查下载的资产，不要求原发行目录存在：

```powershell
python -I -B scripts/archive-offline.py verify --manifest "C:\deliveries\HarnessHub-Windows-ARM64.offline.json"
```

## 工具验证范围

[合成验证](../scripts/check-archive-offline.py)使用临时样例，包含中文/空格路径、空文件、ZIP64、确定性输出、真实分片重组、精确库存、损坏文件、状态、私钥、跨块凭证、Windows junction、遗漏/额外/错序分片和禁止覆盖。Windows 分组实际运行系统 PowerShell 5.1，并证明它会拒绝分片错误以及全档散列正确但内部文件与库存不符的 ZIP。执行入口为：

```powershell
python -I -B scripts/check-archive-offline.py
```

这些测试只证明归档和恢复工具的行为。实际发行包仍需独立执行 `create`、`verify` 和引擎验收；合成通过不能记作某个最终发行包已压缩、上传或通过运行测试。
