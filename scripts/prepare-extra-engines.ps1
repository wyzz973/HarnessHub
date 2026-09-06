[CmdletBinding()]
param(
    [string]$TargetRoot,
    [string]$CacheRoot,
    [ValidateSet('all', 'hermes', 'kiro')][string]$Engine = 'all'
)

# Build/preparation only. Judge-machine startup never runs this downloader.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$hostArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($hostArchitecture -notin @('arm64', 'x64')) { throw 'Windows x64 or ARM64 is required.' }
if (-not $TargetRoot) { $TargetRoot = Join-Path $repository ".tools/contest-prepared/win32-$hostArchitecture" }
if (-not $CacheRoot) { $CacheRoot = Join-Path $repository '.tools/contest-cache/extra-engines' }

function Get-WorkspacePath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = $repository.TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Preparation path must stay inside this checkout: $absolute"
    }
    return $absolute
}

$TargetRoot = Get-WorkspacePath $TargetRoot
$CacheRoot = Get-WorkspacePath $CacheRoot
$sourcesFile = Join-Path $repository 'distribution/extra-engine-sources.json'
$sources = Get-Content -LiteralPath $sourcesFile -Raw | ConvertFrom-Json
$sourceDigest = (Get-FileHash -LiteralPath $sourcesFile -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not ('HarnessHubMsiArchive' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'msi-extract-readonly.cs') }

function Get-VerifiedArtifact($Artifact) {
    if ([IO.Path]::GetFileName($Artifact.file) -ne $Artifact.file) { throw 'Invalid artifact filename.' }
    $path = Join-Path $CacheRoot $Artifact.file
    if (Test-Path -LiteralPath $path) {
        $digest = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($digest -ne $Artifact.sha256) { throw "Cached artifact hash mismatch: $path" }
        return $path
    }
    Write-Host "Downloading $($Artifact.file)"
    $temporary = "$path.partial"
    Invoke-WebRequest -Uri $Artifact.url -OutFile $temporary -UseBasicParsing
    $digest = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne $Artifact.sha256) { throw "Downloaded artifact hash mismatch: $temporary" }
    Move-Item -LiteralPath $temporary -Destination $path
    return $path
}

function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-IsolatedInspection([string]$Executable, [string]$Arguments, [string]$Id) {
    $homePath = Get-WorkspacePath (Join-Path $TargetRoot "validation/extra-engines/$Id")
    New-Item -ItemType Directory -Path $homePath -Force | Out-Null
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $homePath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Clear()
    foreach ($entry in @{
        SystemRoot = $env:SystemRoot; WINDIR = $env:WINDIR; ComSpec = $env:ComSpec
        PATH = (Join-Path $env:SystemRoot 'System32'); TEMP = $homePath; TMP = $homePath
        HOME = $homePath; USERPROFILE = $homePath; LOCALAPPDATA = (Join-Path $homePath 'Local')
        APPDATA = (Join-Path $homePath 'Roaming'); HERMES_HOME = $homePath
        HERMES_DISABLE_LAZY_INSTALLS = '1'
        PYTHONUTF8 = '1'; PYTHONIOENCODING = 'utf-8'
    }.GetEnumerator()) { $start.EnvironmentVariables[$entry.Key] = $entry.Value }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not start engine inspection.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "Engine inspection timed out: $Id"
        }
        $output = $stdout.GetAwaiter().GetResult()
        $errors = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "Engine inspection failed ($Id): $errors" }
        return @{ exitCode = $process.ExitCode; stdout = $output.Trim(); stderr = $errors.Trim() }
    } finally { $process.Dispose() }
}

function Copy-VcRuntime([string]$Destination) {
    $artifact = Get-VerifiedArtifact $sources.artifacts.vclibs
    $unpacked = Join-Path $CacheRoot "vclibs-$($sources.artifacts.vclibs.version)"
    if (-not (Test-Path -LiteralPath $unpacked)) {
        [IO.Compression.ZipFile]::ExtractToDirectory($artifact, $unpacked)
    }
    foreach ($name in $sources.artifacts.vclibs.dlls) {
        $file = Join-Path $unpacked $name
        $signature = Get-AuthenticodeSignature -LiteralPath $file
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
            throw "Microsoft runtime signature validation failed: $name"
        }
        Copy-Item -LiteralPath $file -Destination $Destination -Force
    }
    $notice = Join-Path $Destination 'runtime-source'
    New-Item -ItemType Directory -Path $notice -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $unpacked 'AppxManifest.xml'), (Join-Path $unpacked 'AppxSignature.p7x') -Destination $notice
    Write-Utf8 (Join-Path $notice 'README.txt') "Microsoft VCLibs $($sources.artifacts.vclibs.version), x64 app-local runtime.`r`nSource: $($sources.artifacts.vclibs.url)`r`nSHA256: $($sources.artifacts.vclibs.sha256)`r`nRedistribution terms: https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files`r`nOriginal framework package was only extracted; it was not installed or registered.`r`n"
}

function Assert-NewEngine([string]$Id) {
    $path = Get-WorkspacePath (Join-Path $TargetRoot "engines/$Id")
    if (Test-Path -LiteralPath $path) { throw "Engine preparation directory already exists; choose a fresh TargetRoot: $path" }
    New-Item -ItemType Directory -Path $path | Out-Null
    return $path
}

if ($Engine -in @('all', 'hermes')) {
    $engineRoot = Assert-NewEngine 'hermes'
    $runtime = Join-Path $engineRoot 'runtime'
    $pythonArchive = Get-VerifiedArtifact $sources.artifacts.python
    [IO.Compression.ZipFile]::ExtractToDirectory($pythonArchive, $runtime)
    $python = Join-Path $runtime 'python.exe'
    $pythonSignature = Get-AuthenticodeSignature -LiteralPath $python
    if ($pythonSignature.Status -ne 'Valid' -or $pythonSignature.SignerCertificate.Subject -notmatch 'Python Software Foundation') {
        throw 'Python signature validation failed.'
    }
    Copy-VcRuntime $runtime
    Copy-Item -LiteralPath (Get-VerifiedArtifact $sources.artifacts.pip) -Destination (Join-Path $runtime 'pip.whl')
    Write-Utf8 (Join-Path $runtime 'python313._pth') "python313.zip`r`n.`r`nLib/site-packages`r`npip.whl`r`nimport site`r`n"
    $wheelhouse = Join-Path $engineRoot 'wheelhouse'
    New-Item -ItemType Directory -Path $wheelhouse | Out-Null
    foreach ($wheel in $sources.hermes.wheels) {
        Copy-Item -LiteralPath (Get-VerifiedArtifact $wheel) -Destination $wheelhouse
    }
    $requirements = Join-Path $repository 'distribution/hermes-requirements.lock'
    & $python -I -B -m pip install --disable-pip-version-check --no-compile --no-index --only-binary=:all: --require-hashes --find-links $wheelhouse --target (Join-Path $runtime 'Lib/site-packages') -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'Installing the locked Hermes wheel closure failed.' }
    # pip's console launchers embed this build machine's absolute interpreter path.
    # All distributed entry points use the relocated Python module directly.
    $generatedScripts = Get-WorkspacePath (Join-Path $runtime 'Lib/site-packages/bin')
    if (-not $generatedScripts.StartsWith(($runtime + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid generated-script cleanup target.' }
    if (Test-Path -LiteralPath $generatedScripts) { Remove-Item -LiteralPath $generatedScripts -Recurse -Force }
    $version = Invoke-IsolatedInspection $python '-I -B -m acp_adapter --version' 'hermes-version'
    $check = Invoke-IsolatedInspection $python '-I -B -m acp_adapter --check' 'hermes-check'
    $nativeCheck = Invoke-IsolatedInspection $python '-I -B -c "import win32api, win32event, winpty, cryptography.hazmat.bindings._rust, psutil, PIL._imaging, mcp, acp; print(''Native dependencies import OK'')"' 'hermes-native-imports'
    if (Get-ChildItem -LiteralPath (Join-Path $runtime 'Lib/site-packages') -Filter '*.pyc' -File -Recurse | Select-Object -First 1) { throw 'Hermes package contains nonportable compiled Python files.' }
    if ($version.stdout -ne $sources.hermes.version -or $check.stdout -ne 'Hermes ACP check OK') { throw 'Unexpected Hermes inspection output.' }
    $report = @{ sourceManifestSha256 = $sourceDigest; architecture = 'x64'; hostArchitecture = $hostArchitecture; execution = $(if ($hostArchitecture -eq 'arm64') { 'x64-emulation' } else { 'native-x64' }); entry = $sources.hermes.entry; requiredEnvironment = @{ HERMES_DISABLE_LAZY_INSTALLS = '1'; HERMES_LAZY_INSTALL_TARGET = '' }; version = $version; importCheck = $check; nativeImportCheck = $nativeCheck; wheelCount = $sources.hermes.wheels.Count; modelRequests = 0 }
    Write-Utf8 (Join-Path $engineRoot 'prepared.json') ($report | ConvertTo-Json -Depth 8)
    Copy-Item -LiteralPath $requirements -Destination $engineRoot
    Write-Host 'Hermes package prepared and import-checked.'
}

if ($Engine -in @('all', 'kiro')) {
    $engineRoot = Assert-NewEngine 'kiro'
    $msi = Get-VerifiedArtifact $sources.artifacts.kiro
    $productStateBefore = [HarnessHubMsiArchive]::ProductState($msi)
    $extraction = Get-WorkspacePath (Join-Path $engineRoot 'msi-files')
    $files = [HarnessHubMsiArchive]::Extract($msi, $extraction)
    $sourceEntry = Join-Path $extraction $sources.artifacts.kiro.extractedEntry
    $digest = (Get-FileHash -LiteralPath $sourceEntry -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne $sources.artifacts.kiro.extractedSha256) { throw 'Extracted Kiro executable hash mismatch.' }
    if ($files.Count -ne 1) { throw 'Kiro MSI layout changed; review all files before preparing this version.' }
    $entry = Join-Path $engineRoot 'kiro-cli.exe'
    Move-Item -LiteralPath $sourceEntry -Destination $entry
    $verifiedExtraction = Get-WorkspacePath $extraction
    if (-not $verifiedExtraction.StartsWith(($engineRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid extraction cleanup target.' }
    Remove-Item -LiteralPath $verifiedExtraction -Recurse -Force
    $signature = Get-AuthenticodeSignature -LiteralPath $entry
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Amazon') { throw 'Kiro signature validation failed.' }
    Copy-VcRuntime $engineRoot
    $version = Invoke-IsolatedInspection $entry '--version' 'kiro-version'
    if ($version.stdout -notmatch ('\b' + [regex]::Escape($sources.artifacts.kiro.version) + '$')) { throw 'Unexpected Kiro version.' }
    $productStateAfter = [HarnessHubMsiArchive]::ProductState($msi)
    if ($productStateBefore -ne $productStateAfter) { throw 'MSI product state changed unexpectedly.' }
    $report = @{ sourceManifestSha256 = $sourceDigest; architecture = 'x64'; hostArchitecture = $hostArchitecture; execution = $(if ($hostArchitecture -eq 'arm64') { 'x64-emulation' } else { 'native-x64' }); entry = @('kiro-cli.exe', 'acp'); version = $version; productStateBefore = $productStateBefore; productStateAfter = $productStateAfter; machineInstallation = $false; modelRequests = 0 }
    Write-Utf8 (Join-Path $engineRoot 'prepared.json') ($report | ConvertTo-Json -Depth 8)
    Write-Host 'Kiro package extracted and verified without product installation.'
}
