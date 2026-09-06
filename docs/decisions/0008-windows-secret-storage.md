# Windows 系统密钥存储

状态：accepted。日期：2026-09-06。

## 问题

控制台的新 Key 保存只调用 macOS Security helper，Windows 无法使用。现有 API 接受至多 8 KiB 单行密钥；配置、SQLite 与命令参数不能存放原值。

## 决定

保留 `keychain` 引用类型和 UUID 格式。Windows 使用系统 .NET Framework 编译的窄 C# helper，以 stdin/stdout JSON 传递一次操作，固定应用命名空间，DPAPI CurrentUser 加密后写入 Windows LocalApplicationData/HarnessHub/secrets-v1。密文文件独占创建、目录 owner-only DACL；读取和删除验证 UUID、所有者和 reparse point。Windows 文件秘密引用也验证 DACL。构建缺失的系统依赖或解密失败明确报错。

平台相关文件访问由具体的 `platform/windows-acl` 模块支持产物目录与安全文件测试；该模块不能依赖 Runtime、Gateway 或业务存储。领域与业务模块不能直接引用平台实现，边界检查具有反例。

## 考虑过的替代方案

Windows Credential Manager 的单个 CredentialBlob 上限为 2560 字节，无法保持现有 8 KiB 契约；拆成多条凭据会增加部分写入与清理状态。明文私有文件虽然有 ACL，仍不满足系统加密存储目标。选择 DPAPI 不增加 npm 原生依赖。

凭证根目录通过 [GetUserProfileDirectory](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-getuserprofiledirectoryw) 查询当前 Windows token 的 profile，再定位 AppData/Local；不读取进程 HOME、USERPROFILE 或 LOCALAPPDATA。Gateway 创建的引用在使用私有 HOME/AppData 的 Worker 中仍指向同一当前用户存储。目录仍执行 reparse point 与 DACL 校验，并通过实际目录句柄解析 MSIX 虚拟化后的物理路径；不为私有 Worker 复制凭证或降低目录权限。回归测试在普通环境创建引用，在替换 HOME/AppData 的子进程中校验值的摘要并删除，原进程确认引用失效。

## 后果与验证

DPAPI 保护当前 Windows 用户的静态密文，同一身份的程序仍可解密；这不构成对 Engine/工具进程的隔离。引用不可跨账户/机器直接恢复；现有 macOS 引用无需迁移，也不会被 Windows 静默重建。测试覆盖超过 Credential Manager 上限的值、密文不含原文、不同 UUID、跨 helper 调用读取、删除后不可用、非法引用与私有文件读取。Windows 10/11 和架构的验收范围以执行记录为准。

依据：[Microsoft DPAPI CurrentUser](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope)、[CredentialBlob 限制](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentiala)。
