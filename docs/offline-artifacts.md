# 离线发行文件与分片恢复

[归档工具](../scripts/archive-offline.py)把已准备完成的 Windows 发行目录转换成可上传的离线资产。它使用 Python 标准库，不下载或安装依赖，不启动模型。发行目录必须带有与实际文件完全一致的 `bundle.json`，并已停止服务、移出运行状态。Windows 端用 [Restore-Offline.ps1](../distribution/Restore-Offline.ps1)校验和恢复，不需要安装 Python。

## 在开发机创建归档

使用已有 Python，传入明确的绝对路径；ZIP 输出必须位于发行目录外，目标 ZIP、同名分片和 manifest 均不能已存在：

```powershell
python -I -B scripts/archive-offline.py create --bundle "C:\release\HarnessHub-win32-arm64" --zip "C:\deliveries\HarnessHub-Windows-ARM64.zip"
```

工具检查实际文件集合与 `bundle.json` 完全一致，逐文件核对大小和 SHA256，然后生成包含一个根目录的 ZIP64 归档。ZIP 成员顺序、时间戳、文件属性与压缩级别固定；同一 Python/zlib 环境下相同输入字节产生相同 ZIP。不同压缩库版本仍以本次输出记录的精确 SHA256 为准。

Windows 磁盘访问统一使用扩展绝对路径，支持超过 260 字符的发行目录、依赖文件、资产及临时重组路径；不会修改机器的 `LongPathsEnabled` 或其他全局策略。ZIP 内仍保存普通相对路径。

源文件校验使用固定最多 16 个读取线程，每批最多 16 个任务，全部完成并关闭句柄后才处理下一批。ZIP 仍由主线程按排序顺序写入：每批并发预读不超过 1 MiB 的小文件，持有的预读数据合计不超过 16 MiB；更大的文件继续流式读取。该上限不包含库存、运行库及 I/O/压缩缓冲；每次预读最多多读 1 字节以发现文件增长，不使用无限制的 `read()`。上一批缓存会在开始下一批前释放。

预读仍核对大小、SHA256、秘密以及读取前后的文件身份和时间戳，写入该成员前后也检查文件未变化。任何线程失败都等待同批任务结束并关闭句柄，归档不能发布；最终 ZIP 的全部成员仍须逐个重读校验。这些检查用于检测正常打包期间的意外变化，不等同于文件系统快照或针对恶意并发目录替换的隔离。

它拒绝 `state/`、`.incomplete`、文件树中的符号链接和 Windows reparse point，以及 `.env*`、DPAPI、SQLite、账号凭证、SSH 私钥等已列明的敏感文件。内容检查拒绝 PEM 私钥材料，只有下述按精确路径和整文件 SHA256 审查过的公开上游自检数据例外。可对本次测试实际使用的密钥补充精确检查，命令只传环境变量名：

凭证文件名规则只应用于文件；SDK 中名为 `credentials` 的源码目录可以保留，其内部文件仍接受精确库存、大小/SHA256 和内容秘密检查。`.ssh` 等私人配置目录和根 `state/` 的目录拒绝规则不受影响。

```powershell
python -I -B scripts/archive-offline.py create --bundle "C:\release\HarnessHub-win32-arm64" --zip "C:\deliveries\HarnessHub-Windows-ARM64.zip" --secret-env DEEPSEEK_API_KEY
```

该变量必须已经存在且至少 8 个字符；工具检查其 UTF-8、UTF-16LE 字节，跨读取块也能发现，不在日志或 manifest 中保存值。可以重复使用 `--secret-env` 检查多个已知凭证。上述检查不推断任意字符串是否为秘密，也不递归解包 ZIP 内嵌的第三方归档；发行目录仍应来自干净的打包流程，不能直接复制个人账号目录。

### 公开自检材料审查清单

唯一已审查的文件为 `bin/git/usr/bin/msys-gnutls-30.dll`（2,029,128 字节），SHA256 为 `5f3019ca853a642a5d26b81661040f295cc11cfc588a43500fbcb2fbee7cc444`。它来自 [PortableGit 2.55.0.5 ARM64 官方资产](https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/PortableGit-2.55.0.5-arm64.7z.exe)，原下载文件实际 SHA256 与准备收据一致：`49d1dd3158017fa9805d07268433dbab7021b2ec1c1cc3fbabaf8b8255764dd0`。

2026-09-07 的只读审查把 DLL 中全部 11 个完整 PEM 私钥格式块，与 [GnuTLS 3.8.13 固定提交的公开自检代码](https://github.com/gnutls/gnutls/blob/b390d80208ed60f1b33ad899475951a8efb40ccd/lib/crypto-selftests-pk.c)逐块比对：解析 C 字符串后，从 BEGIN 到 END 标记的字节及 SHA256 全部相同。这些常量属于上游密码运算自检，并非本机账号私钥。该上游源码文件 SHA256 为 `6e596be00754107fd7f7d1f132c2dc8cd0ff12bbdfc6de08c162a1dd5eedc7e8`；本文和检查日志不记录 PEM 内容。

归档器只允许上述路径与整文件 SHA256 同时匹配的文件携带这些公开常量；改动一个字节、移到其他路径，或升级为不同上游二进制都必须重新审查。该例外同时用于源文件读取、ZIP 写入和每个 ZIP 成员的复读验证，不能从命令行扩充。`--secret-env` 指定值仍无条件拒绝，公开自检例外不能绕过它；其他二进制和文本使用相同的默认内容检查。

## 生成的文件

每个归档生成一个 `HarnessHub-Windows-ARM64.offline.json`，记录完整 ZIP 大小/SHA256、内部 `bundle.json` 的 SHA256、有序资产清单，以及本次逐成员验证结果。

- ZIP 小于 2 GiB 时，资产为一个 `.zip` 文件。
- ZIP 达到 2 GiB 时，资产为 `.zip.part001`、`.zip.part002` 等分片，每片最多 1,932,735,283 字节，即向下取整的 1.8 GiB。
- 每片均记录索引、严格文件名、大小和 SHA256；全档 SHA256 独立记录。分片模式不发布超过限制的完整 ZIP。
- 工具重新读取最终资产、重组 ZIP，并再次读取 ZIP 中每个文件核对大小和 SHA256 后，才最后写出 `.offline.json` 完成标记。

上传 Release 时包含 manifest、manifest 的 `parts` 数组列出的全部文件，以及本仓库的 `Restore-Offline.ps1`。恢复脚本可通过仓库代码或同次 Release 获取；归档工具不会自动上传 GitHub，也不会改变账号设置。准备归档时峰值临时磁盘空间约为完整 ZIP 的 3 倍，除此之外还需保留原发行目录。

## Windows 内网校验与恢复

将 manifest、全部分片或单个 ZIP、`Restore-Offline.ps1` 放在同一目录。下面使用本次 Windows 11 ARM64 开源发行包的准确文件名；其他发行包应使用其对应 manifest。选择一个尚不存在的输出 `.zip`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Restore-Offline.ps1 -Manifest .\HarnessHub-OpenSource-Windows-ARM64.offline.json -OutputZip .\HarnessHub-restored.zip
if ($LASTEXITCODE -ne 0) { throw '离线包恢复失败，请先检查上面的错误' }
Expand-Archive -LiteralPath .\HarnessHub-restored.zip -DestinationPath C:\HH
```

本次解压后的入口在 `C:\HH\HarnessHub-OpenSource-Windows-ARM64`。按 [内网启动](offline-company.md#内网启动)配置公司模型；若使用 `COMPANY_MODEL_API_KEY` 环境引用，在已设置该变量的同一 PowerShell 中执行 `& 'C:\HH\HarnessHub-OpenSource-Windows-ARM64\Start.cmd'`，让子进程继承密钥引用所需环境。

`-ExecutionPolicy Bypass` 只对该 PowerShell 进程生效，不更改机器或用户的执行策略。脚本兼容 Windows PowerShell 5.1 和 PowerShell 7，使用系统 .NET ZIP/SHA256 能力，不连接网络。脚本先验证全部分片、重组后的完整 SHA256，再打开 ZIP，核对清单、所有成员、文件大小和每个文件 SHA256；成功后才把临时文件发布为指定输出。

恢复脚本按 ZIP entry stream 校验内部文件，不把成员逐一写到磁盘，因此内部长路径不影响这个校验步骤。最终解压应选择 `C:\HH` 这类短目录，避免 Windows PowerShell 5.1 解压工具的路径长度限制；不要为此开启机器全局长路径策略。manifest、资产和输出 ZIP 本身也应放在短目录。

缺少分片、多余分片、索引乱序、文件名不符、大小或散列错误、链接、ZIP 内额外文件、路径越界、成员损坏以及已有输出目标都会返回非零。失败时不会覆盖原目标，自己的 `.incomplete` 文件会清理。恢复需要额外容纳完整 ZIP 的磁盘空间；解压还需要容纳发行目录。仅在恢复脚本退出 0 后解压并按发行包说明启动。

已有 Python 的开发机也可独立检查下载的资产，不要求原发行目录存在：

```powershell
python -I -B scripts/archive-offline.py verify --manifest "C:\deliveries\HarnessHub-Windows-ARM64.offline.json"
```

## 工具验证范围

[合成验证](../scripts/check-archive-offline.py)使用临时样例，包含中文/空格路径、空文件、ZIP64、确定性输出、真实分片重组、精确库存、损坏文件、状态、私钥、跨块凭证、Windows junction、遗漏/额外/错序分片和禁止覆盖。Windows 分组实际运行系统 PowerShell 5.1，并证明它会拒绝分片错误以及全档散列正确但内部文件与库存不符的 ZIP。执行入口为：

并发回归覆盖超过两个批次的小文件、0/1 MiB/1 MiB 加 1 字节边界、单写入线程、排序和相同归档字节、后续批次的坏散列及秘密、预读期间增长、预读后写入前变化，以及非首项线程失败后等待其他线程关闭所有句柄。另记录真实临时文件在 1 与 16 个读取线程下的耗时，不以不稳定的速度阈值判定通过。

```powershell
python -I -B scripts/check-archive-offline.py
```

这些测试只证明归档和恢复工具的行为。实际发行包仍需独立执行 `create`、`verify` 和引擎验收；合成通过不能记作某个最终发行包已压缩、上传或通过运行测试。
