[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Manifest,
    [Parameter(Mandatory = $true)][string]$OutputZip
)

# Windows PowerShell 5.1 / PowerShell 7; only inbox .NET APIs, no downloads.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$temporary = $null

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Regular([string]$File, [bool]$Directory = $false) {
    $item = Get-Item -LiteralPath $File -Force
    Assert-True (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Link/reparse point rejected: $File"
    Assert-True ($item.PSIsContainer -eq $Directory) "Unexpected filesystem entry: $File"
    return $item
}

function Assert-Relative([string]$Name) {
    Assert-True (-not [string]::IsNullOrEmpty($Name)) 'Empty inventory name'
    Assert-True (-not $Name.Contains('\') -and -not $Name.StartsWith('/') -and -not $Name.Contains(':')) 'Unsafe inventory name'
    $pieces = $Name.Split('/')
    foreach ($piece in $pieces) {
        Assert-True ($piece -ne '' -and $piece -ne '.' -and $piece -ne '..' -and -not $piece.EndsWith('.') -and -not $piece.EndsWith(' ') -and -not $piece.Contains([char]0)) 'Unsafe inventory segment'
        Assert-True ($piece.ToLowerInvariant() -notin @('.git', '.ssh', '.aws', '.azure', '.gnupg')) 'Private configuration directory in payload'
    }
    Assert-True ($pieces[0].ToLowerInvariant() -notin @('state', '.incomplete')) 'Mutable/incomplete payload'
    $leaf = $pieces[$pieces.Length - 1].ToLowerInvariant()
    Assert-True ($leaf -notin @('auth.json', 'credentials.json', 'credentials', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519')) 'Credential file in payload'
    Assert-True ($leaf -notmatch '(?:^\.env(?:\.|$)|\.(?:dpapi|sqlite(?:-wal|-shm)?|p12|pfx)$)') 'Credential/state file in payload'
}

function Get-StreamHash([IO.Stream]$Stream) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Get-BytesHash([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Assert-Digest([object]$Digest) {
    Assert-True ($Digest -is [string] -and $Digest -cmatch '^[a-f0-9]{64}$') 'Invalid SHA256'
}

try {
    $manifestPath = [IO.Path]::GetFullPath($Manifest)
    $outputPath = [IO.Path]::GetFullPath($OutputZip)
    $assetDirectory = [IO.Path]::GetDirectoryName($manifestPath)
    $outputDirectory = [IO.Path]::GetDirectoryName($outputPath)
    $null = Assert-Regular $assetDirectory $true
    $null = Assert-Regular $outputDirectory $true
    Assert-True (-not (Test-Path -LiteralPath $outputPath)) 'Output already exists; overwrite is prohibited'
    Assert-True ($outputPath.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) 'Output must end in .zip'
    $manifestInfo = Assert-Regular $manifestPath
    Assert-True ($manifestInfo.Length -le 64MB) 'Oversized asset manifest'
    $release = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-True ($release.schemaVersion -eq 1) 'Unsupported asset manifest'
    Assert-Relative $release.zipName
    Assert-Relative $release.bundleRootName
    Assert-True (-not $release.zipName.Contains('/') -and -not $release.bundleRootName.Contains('/') -and $release.zipName.EndsWith('.zip')) 'Invalid archive/root name'
    Assert-Digest $release.zipSha256
    Assert-Digest $release.bundleManifestSha256
    Assert-True ($release.zipBytes -is [long] -or $release.zipBytes -is [int]) 'Invalid archive size type'
    Assert-True ($release.zipBytes -gt 0) 'Invalid archive size'
    $parts = @($release.parts)
    Assert-True ($parts.Count -gt 0) 'No archive parts'
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $total = [long]0
    for ($index = 0; $index -lt $parts.Count; $index++) {
        $part = $parts[$index]
        $expected = $release.zipName
        if ($parts.Count -gt 1) { $expected = '{0}.part{1:d3}' -f $release.zipName, ($index + 1) }
        Assert-True ($part.index -eq ($index + 1) -and $part.file -ceq $expected) 'Archive part order/name mismatch'
        Assert-True ($part.bytes -is [long] -or $part.bytes -is [int]) 'Invalid archive part size type'
        Assert-True ($part.bytes -gt 0 -and $part.bytes -lt 2147483648) 'Archive part exceeds asset limit'
        if ($parts.Count -gt 1) { Assert-True ($part.bytes -le 1932735283) 'Archive part exceeds 1.8 GiB' }
        Assert-Digest $part.sha256
        $null = $names.Add($part.file)
        $total += $part.bytes
    }
    Assert-True ($total -eq $release.zipBytes) 'Archive part size total differs'
    foreach ($file in Get-ChildItem -LiteralPath $assetDirectory -Force) {
        if ($file.Name.StartsWith($release.zipName + '.part', [StringComparison]::OrdinalIgnoreCase)) {
            Assert-True ($names.Contains($file.Name)) "Unexpected archive part: $($file.Name)"
        }
    }
    $temporary = $outputPath + '.' + [Guid]::NewGuid().ToString('N') + '.incomplete'
    Assert-True ([IO.Path]::GetDirectoryName($temporary) -eq $outputDirectory) 'Unsafe temporary output path'
    $output = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        foreach ($part in $parts) {
            $partPath = Join-Path $assetDirectory $part.file
            $info = Assert-Regular $partPath
            Assert-True ($info.Length -eq $part.bytes) "Archive part size mismatch: $($part.file)"
            $input = [IO.File]::Open($partPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                Assert-True ((Get-StreamHash $input) -ceq $part.sha256) "Archive part SHA256 mismatch: $($part.file)"
                $input.Position = 0
                $input.CopyTo($output, 1048576)
            }
            finally { $input.Dispose() }
            Write-Host ('Verified part {0}/{1}' -f $part.index, $parts.Count)
        }
    }
    finally { $output.Dispose() }
    $assembled = Assert-Regular $temporary
    Assert-True ($assembled.Length -eq $release.zipBytes) 'Assembled ZIP size mismatch'
    $input = [IO.File]::OpenRead($temporary)
    try { Assert-True ((Get-StreamHash $input) -ceq $release.zipSha256) 'Assembled ZIP SHA256 mismatch' }
    finally { $input.Dispose() }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($temporary)
    try {
        $rootPrefix = $release.bundleRootName + '/'
        $manifestEntry = $zip.GetEntry($rootPrefix + 'bundle.json')
        Assert-True ($null -ne $manifestEntry -and $manifestEntry.Length -le 64MB) 'Missing/oversized archived bundle.json'
        $stream = $manifestEntry.Open()
        $memory = [IO.MemoryStream]::new()
        try { $stream.CopyTo($memory); $manifestBytes = $memory.ToArray() }
        finally { $stream.Dispose(); $memory.Dispose() }
        Assert-True ((Get-BytesHash $manifestBytes) -ceq $release.bundleManifestSha256) 'Archived bundle.json SHA256 mismatch'
        $bundle = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
        Assert-True ($bundle.schemaVersion -eq 1 -and $bundle.platform -eq 'win32' -and $bundle.arch -in @('arm64', 'x64')) 'Unsupported bundle manifest'
        $inventory = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
        $folded = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $null = $folded.Add('bundle.json')
        foreach ($record in @($bundle.files)) {
            Assert-Relative $record.path
            Assert-True ($folded.Add($record.path.Normalize([Text.NormalizationForm]::FormC))) 'Duplicate inventory path'
            Assert-True (($record.size -is [int] -or $record.size -is [long]) -and $record.size -ge 0 -and $record.size -le 9007199254740991) 'Invalid inventoried size'
            Assert-Digest $record.sha256
            $inventory.Add($rootPrefix + $record.path, $record)
        }
        Assert-True ($inventory.Count -gt 0) 'Empty bundle inventory'
        $inventory.Add($rootPrefix + 'bundle.json', @{ size = $manifestBytes.Length; sha256 = $release.bundleManifestSha256 })
        Assert-True ($zip.Entries.Count -eq ($inventory.Count + 1)) 'ZIP member count differs from inventory'
        $visited = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $verified = 0
        foreach ($entry in $zip.Entries) {
            Assert-True ($visited.Add($entry.FullName.Normalize([Text.NormalizationForm]::FormC))) 'Duplicate ZIP member'
            Assert-True ((($entry.ExternalAttributes -shr 16) -band 0xF000) -ne 0xA000) 'ZIP symlink rejected'
            if ($entry.FullName -ceq $rootPrefix) {
                Assert-True ($entry.Length -eq 0) 'Invalid ZIP root directory'
                continue
            }
            Assert-True ($inventory.ContainsKey($entry.FullName)) 'Extra or differently named ZIP member'
            $expected = $inventory[$entry.FullName]
            Assert-True ($entry.Length -eq $expected.size) "ZIP member size mismatch: $($entry.FullName)"
            $stream = $entry.Open()
            try { Assert-True ((Get-StreamHash $stream) -ceq $expected.sha256) "ZIP member SHA256 mismatch: $($entry.FullName)" }
            finally { $stream.Dispose() }
            $verified++
            if (($verified % 1000) -eq 0) { Write-Host "Verified $verified ZIP files" }
        }
        Assert-True ($verified -eq $inventory.Count) 'Missing ZIP member'
    }
    finally { $zip.Dispose() }
    [IO.File]::Move($temporary, $outputPath)
    $temporary = $null
    @{ verified = $true; zip = $outputPath; sha256 = $release.zipSha256; fileCount = $verified; networkUsed = $false } | ConvertTo-Json
}
catch {
    Write-Error -Message ('Offline restore failed: ' + $_.Exception.Message) -ErrorAction Continue
    exit 1
}
finally {
    if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
