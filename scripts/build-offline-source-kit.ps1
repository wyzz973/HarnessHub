param(
  [Parameter(Mandatory = $true)][string]$Prepared,
  [Parameter(Mandatory = $true)][string]$Output
)

# Assemble the Windows x64 offline development kit (network is used here, on the build
# machine only): editable HarnessHub source with node_modules, the offline pnpm store,
# Node/pnpm, the prepared engine payload, upstream source snapshots and the offline
# competition entry points (Setup-Competition-Offline.cmd, Start-Competition.cmd,
# INSTRUCTION.md). The kit itself never downloads; see scripts/competition-offline.mjs.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Prepared = (Resolve-Path $Prepared).Path
$Kit = [System.IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Kit) { throw "Output already exists; choose a new directory: $Kit" }
New-Item -ItemType Directory -Path $Kit | Out-Null

function Copy-Tree([string]$Source, [string]$Target) {
  robocopy $Source $Target /E /R:2 /W:1 *> $null
  if ($LASTEXITCODE -gt 7) { throw "robocopy failed: $Source -> $Target ($LASTEXITCODE)" }
}

function Write-CrlfFile([string]$Path, [string[]]$Lines) {
  # cmd.exe parses labels reliably only with CRLF; keep launchers ASCII for every code page.
  $Text = ($Lines -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.Encoding]::ASCII)
}

function Write-Utf8File([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Normalize-Repo([string]$Repository) {
  if (-not $Repository) { return $null }
  $Repository = $Repository -replace '^git\+', ''
  $Repository = $Repository -replace '^git://github.com/', 'https://github.com/'
  $Repository = $Repository -replace '^github:', 'https://github.com/'
  if ($Repository -match '^https://github.com/.+\.git$') { return $Repository }
  if ($Repository -match '^https://github.com/') { return ($Repository.TrimEnd('/') + '.git') }
  return $Repository
}

function Get-OptionalProperty([object]$Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $Property = $Object.PSObject.Properties[$Name]
  if ($null -eq $Property) { return $null }
  return $Property.Value
}

function Try-GitSnapshot([string]$Destination, [string]$Repository, [string]$Ref, [switch]$Commit) {
  Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  try {
    git -C $Destination init *> $null
    if ($LASTEXITCODE -ne 0) { throw "git init failed" }
    git -C $Destination remote add origin $Repository *> $null
    if ($LASTEXITCODE -ne 0) { throw "git remote failed" }
    if ($Commit) {
      git -C $Destination fetch --depth 1 origin $Ref *> $null
    } else {
      git -C $Destination fetch --depth 1 origin "refs/tags/$Ref:refs/tags/$Ref" *> $null
    }
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
    if ($Commit) {
      git -C $Destination checkout --detach FETCH_HEAD *> $null
    } else {
      git -C $Destination checkout --detach "refs/tags/$Ref" *> $null
    }
    if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }
    Remove-Item -Recurse -Force (Join-Path $Destination ".git")
    return $true
  } catch {
    Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
    return $false
  }
}

function Try-GitDefaultSnapshot([string]$Destination, [string]$Repository) {
  Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
  git clone --depth 1 $Repository $Destination *> $null
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
    return $false
  }
  Remove-Item -Recurse -Force (Join-Path $Destination ".git")
  return $true
}

# Editable source. Root-level runtime data (.tmp holds preparation downloads, including
# proprietary archives that are never redistributed) is excluded by full path so that
# same-named source folders such as src/gateway/competition are kept.
$HarnessHub = Join-Path $Kit "HarnessHub"
New-Item -ItemType Directory -Force -Path $HarnessHub | Out-Null
$RootExclusions = @(".git", ".tools", ".tmp", ".cache", "data", "output", "coverage", "runtime-data", ".playwright-mcp", ".artifact-x64", ".artifact-offline-source") | ForEach-Object { Join-Path $Repo $_ }
robocopy $Repo $HarnessHub /E /R:2 /W:1 /XD @RootExclusions node_modules dist .next /XF *.zip *.7z *> $null
if ($LASTEXITCODE -gt 7) { throw "Failed to copy HarnessHub source" }

$Tools = Join-Path $Kit "tools"
New-Item -ItemType Directory -Force -Path (Join-Path $Tools "node") | Out-Null
$Node = (Get-Command node).Source
Copy-Item -LiteralPath $Node -Destination (Join-Path $Tools "node\node.exe")
$NodeLicense = Join-Path (Split-Path $Node) "LICENSE"
if (Test-Path $NodeLicense) { Copy-Item $NodeLicense (Join-Path $Tools "node\LICENSE") }
Copy-Tree (Join-Path $Repo ".tools\pnpm-runner") (Join-Path $Tools "pnpm-runner")

$StorePath = (pnpm store path).Trim()
Write-Host "Materializing portable HarnessHub node_modules from offline store"
Push-Location $HarnessHub
try {
  pnpm install --offline --frozen-lockfile --store-dir $StorePath --config.node-linker=hoisted --package-import-method=copy
  if ($LASTEXITCODE -ne 0) { throw "Offline HarnessHub dependency materialization failed" }
} finally {
  Pop-Location
}
# The store path ends in its layout version (for pnpm 10 typically `v10`); --store-dir takes
# the parent and appends that version itself, so keep the version directory in the kit.
$StoreVersion = Split-Path $StorePath -Leaf
Copy-Tree $StorePath (Join-Path $Kit "pnpm-store\$StoreVersion")
Copy-Tree $Prepared (Join-Path $Kit "prepared\win32-x64")

$SourceRoot = Join-Path $Kit "engine-sources"
$PublishedRoot = Join-Path $Kit "published-engine-packages"
New-Item -ItemType Directory -Force -Path $SourceRoot,$PublishedRoot | Out-Null
$Manifest = New-Object System.Collections.Generic.List[object]

function Add-NpmSnapshot([string]$Id,[string]$Spec,[string]$InstalledRelative) {
  Write-Host "Source snapshot: $Id <- $Spec"
  $MetaJson = npm view $Spec --json
  if ($LASTEXITCODE -ne 0) { throw "npm metadata lookup failed: $Spec" }
  $Meta = $MetaJson | ConvertFrom-Json

  $RepoMetadata = Get-OptionalProperty $Meta "repository"
  $RepoValue = if ($RepoMetadata -is [string]) {
    [string]$RepoMetadata
  } elseif ($RepoMetadata) {
    [string](Get-OptionalProperty $RepoMetadata "url")
  } else {
    $null
  }
  $Upstream = Normalize-Repo $RepoValue
  $GitHeadValue = Get-OptionalProperty $Meta "gitHead"
  $GitHead = if ($GitHeadValue) { [string]$GitHeadValue } else { "" }
  $VersionValue = Get-OptionalProperty $Meta "version"
  $Version = if ($VersionValue) { [string]$VersionValue } else { "" }
  $NameValue = Get-OptionalProperty $Meta "name"
  $PackageName = if ($NameValue) { [string]$NameValue } else { "" }
  $Destination = Join-Path $SourceRoot $Id
  $Snapshot = "published-package-only"

  if ($Upstream -and $GitHead -and (Try-GitSnapshot $Destination $Upstream $GitHead -Commit)) {
    $Snapshot = "gitHead:$GitHead"
  } elseif ($Upstream -and $Version) {
    $Candidates = New-Object System.Collections.Generic.List[string]
    foreach ($Candidate in @("v$Version", $Version, $(if ($PackageName) { "$PackageName@$Version" } else { $null }), $(if ($Id -eq "codex") { "rust-v$Version" } else { $null }))) {
      if ($Candidate -and -not $Candidates.Contains($Candidate)) { $Candidates.Add($Candidate) }
    }
    foreach ($Candidate in $Candidates) {
      if (Try-GitSnapshot $Destination $Upstream $Candidate) {
        $Snapshot = "tag:$Candidate"
        break
      }
    }
    if ($Snapshot -eq "published-package-only" -and (Try-GitDefaultSnapshot $Destination $Upstream)) {
      $Snapshot = "repository-default; exact runtime remains under prepared/win32-x64"
    }
  } elseif ($Upstream -and (Try-GitDefaultSnapshot $Destination $Upstream)) {
    $Snapshot = "repository-default; exact runtime remains under prepared/win32-x64"
  }

  $Installed = Join-Path $Prepared $InstalledRelative
  if (-not (Test-Path $Installed)) { throw "Prepared package missing: $Id ($Installed)" }
  if ($Snapshot -eq "published-package-only") {
    Copy-Tree $Installed (Join-Path $PublishedRoot $Id)
  }

  $Manifest.Add([pscustomobject]@{
    id = $Id
    package = $Spec
    version = $Version
    repository = $Upstream
    gitHead = $GitHead
    snapshot = $Snapshot
    exactRuntimePath = "prepared/win32-x64/$($InstalledRelative -replace '\\','/')"
  })
}

Add-NpmSnapshot "codex" "@openai/codex@0.153.4" "engines\npm\node_modules\@openai\codex"
Add-NpmSnapshot "codex-acp" "@agentclientprotocol/codex-acp@1.10.0" "engines\npm\node_modules\@agentclientprotocol\codex-acp"
Add-NpmSnapshot "gemini" "@google/gemini-cli@0.58.0" "engines\npm\node_modules\@google\gemini-cli"
Add-NpmSnapshot "qwen" "@qwen-code/qwen-code@0.23.0" "engines\npm\node_modules\@qwen-code\qwen-code"
Add-NpmSnapshot "pi" "@earendil-works/pi-coding-agent@0.85.1" "engines\npm\node_modules\@earendil-works\pi-coding-agent"
Add-NpmSnapshot "pi-acp" "pi-acp@0.0.33" "engines\npm\node_modules\pi-acp"
Add-NpmSnapshot "mimo" "@mimo-ai/cli@0.1.14" "engines\npm\node_modules\@mimo-ai\cli"
Add-NpmSnapshot "dsh" "@deepseek-ai/dsh@0.1.2-rc.1" "engines\npm\node_modules\@deepseek-ai\dsh"
Add-NpmSnapshot "openclaw" "openclaw@2026.9.2" "engines\npm\node_modules\openclaw"

function Add-NativeSourceSnapshot(
  [string]$Id,
  [string]$Repository,
  [string]$Version,
  [string[]]$Refs,
  [string]$PreparedRelative
) {
  Write-Host "Source snapshot: $Id <- $Repository ($Version)"
  $Destination = Join-Path $SourceRoot $Id
  $Snapshot = $null
  foreach ($Ref in $Refs) {
    $IsCommit = $Ref -match '^[0-9a-fA-F]{40}$'
    $Ok = if ($IsCommit) {
      Try-GitSnapshot $Destination $Repository $Ref -Commit
    } else {
      Try-GitSnapshot $Destination $Repository $Ref
    }
    if ($Ok) {
      $Snapshot = if ($IsCommit) { "commit:$Ref" } else { "tag:$Ref" }
      break
    }
  }
  if (-not $Snapshot) {
    if (Try-GitDefaultSnapshot $Destination $Repository) {
      $Snapshot = "repository-default; exact runtime remains under prepared/win32-x64"
    } else {
      throw "Unable to snapshot $Id from $Repository"
    }
  }
  $Installed = Join-Path $Prepared $PreparedRelative
  if (-not (Test-Path $Installed)) { throw "Prepared native engine missing: $Id" }
  $Manifest.Add([pscustomobject]@{
    id = $Id
    package = $null
    version = $Version
    repository = $Repository
    gitHead = $(if ($Snapshot.StartsWith("commit:")) { $Snapshot.Substring(7) } else { $null })
    snapshot = $Snapshot
    exactRuntimePath = "prepared/win32-x64/$($PreparedRelative -replace '\\','/')"
  })
}

Add-NativeSourceSnapshot "kimi" "https://github.com/MoonshotAI/kimi-cli.git" "1.50.0" @(
  "86f136422a0aae6b217ea49e7ea1d2e8a1defcd2",
  "1.50.0",
  "v1.50.0"
) "engines\kimi"
Add-NativeSourceSnapshot "opencode" "https://github.com/anomalyco/opencode.git" "1.18.29" @(
  "v1.18.29",
  "1.18.29"
) "engines\opencode"

Write-Host "Source snapshot: hermes-agent==0.19.0"
$HermesMeta = Invoke-RestMethod "https://pypi.org/pypi/hermes-agent/0.19.0/json"
$HermesInfo = Get-OptionalProperty $HermesMeta "info"
$ProjectUrls = Get-OptionalProperty $HermesInfo "project_urls"
$HomePage = Get-OptionalProperty $HermesInfo "home_page"
$HermesCandidates = @()
if ($ProjectUrls) { $HermesCandidates += @($ProjectUrls.PSObject.Properties.Value) }
if ($HomePage) { $HermesCandidates += [string]$HomePage }
$HermesRepo = $HermesCandidates | Where-Object { $_ -match '^https://github.com/' } | Select-Object -First 1
$HermesSnapshot = "sdist"
if ($HermesRepo) {
  $HermesRepo = Normalize-Repo $HermesRepo
  $HermesDestination = Join-Path $SourceRoot "hermes"
  foreach ($Ref in @("v0.19.0","0.19.0")) {
    if (Try-GitSnapshot $HermesDestination $HermesRepo $Ref) {
      $HermesSnapshot = "tag:$Ref"
      break
    }
  }
  if ($HermesSnapshot -eq "sdist" -and (Try-GitDefaultSnapshot $HermesDestination $HermesRepo)) {
    $HermesSnapshot = "repository-default + exact sdist"
  }
}
$HermesPublished = Join-Path $PublishedRoot "hermes"
New-Item -ItemType Directory -Force -Path $HermesPublished | Out-Null
# `pip download` would evaluate Requires-Python against the runner's Python; download the
# exact sdist named by the PyPI metadata instead and verify its published SHA-256.
$HermesUrls = @(Get-OptionalProperty $HermesMeta "urls")
$HermesSdist = $HermesUrls | Where-Object { $_.packagetype -eq "sdist" } | Select-Object -First 1
if (-not $HermesSdist) { throw "PyPI metadata has no Hermes 0.19.0 source distribution" }
$HermesSdistPath = Join-Path $HermesPublished ([string]$HermesSdist.filename)
Invoke-WebRequest -Uri ([string]$HermesSdist.url) -OutFile $HermesSdistPath
$HermesDigests = Get-OptionalProperty $HermesSdist "digests"
$HermesExpectedSha = if ($HermesDigests) { [string](Get-OptionalProperty $HermesDigests "sha256") } else { "" }
if ($HermesExpectedSha) {
  $HermesActualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $HermesSdistPath).Hash.ToLowerInvariant()
  if ($HermesActualSha -ne $HermesExpectedSha.ToLowerInvariant()) {
    throw "Hermes 0.19.0 source distribution hash mismatch"
  }
}
$Manifest.Add([pscustomobject]@{
  id = "hermes"
  package = "hermes-agent==0.19.0"
  version = "0.19.0"
  repository = $HermesRepo
  gitHead = $null
  snapshot = $HermesSnapshot
  exactRuntimePath = "prepared/win32-x64/engines/hermes"
})

$Manifest | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 (Join-Path $Kit "engine-source-manifest.json")
git -C $Repo rev-parse HEAD | Set-Content -Encoding Ascii (Join-Path $Kit "HARNESSHUB_COMMIT.txt")

# Developer loop. PATH puts the bundled Node first so package scripts never need a system Node.
Write-CrlfFile (Join-Path $Kit "Build-HarnessHub.cmd") @(
  '@echo off',
  'setlocal',
  'set "ROOT=%~dp0"',
  'set "PATH=%ROOT%tools\node;%PATH%"',
  'cd /d "%ROOT%HarnessHub"',
  '"%ROOT%tools\node\node.exe" "%ROOT%tools\pnpm-runner\node_modules\pnpm\bin\pnpm.cjs" build',
  'exit /b %ERRORLEVEL%'
)
Write-CrlfFile (Join-Path $Kit "Test-HarnessHub.cmd") @(
  '@echo off',
  'setlocal',
  'set "ROOT=%~dp0"',
  'set "PATH=%ROOT%tools\node;%PATH%"',
  'cd /d "%ROOT%HarnessHub"',
  '"%ROOT%tools\node\node.exe" "%ROOT%tools\pnpm-runner\node_modules\pnpm\bin\pnpm.cjs" test',
  'exit /b %ERRORLEVEL%'
)
Write-CrlfFile (Join-Path $Kit "Reinstall-Offline.cmd") @(
  '@echo off',
  'setlocal',
  'set "ROOT=%~dp0"',
  'set "PATH=%ROOT%tools\node;%PATH%"',
  'set "npm_config_offline=true"',
  'cd /d "%ROOT%HarnessHub"',
  'if exist node_modules rmdir /s /q node_modules',
  '"%ROOT%tools\node\node.exe" "%ROOT%tools\pnpm-runner\node_modules\pnpm\bin\pnpm.cjs" install --offline --frozen-lockfile --store-dir "%ROOT%pnpm-store" --config.node-linker=hoisted --package-import-method=copy',
  'exit /b %ERRORLEVEL%'
)

# Competition entry points (see INSTRUCTION.md). Setup is fully offline; Start refuses to
# guess an engine: AGENT_ENGINE selects it, as the competition requires.
Write-CrlfFile (Join-Path $Kit "Setup-Competition-Offline.cmd") @(
  '@echo off',
  'setlocal',
  'set "KIT=%~dp0"',
  'set "NODE=%KIT%tools\node\node.exe"',
  'if not exist "%NODE%" goto missing_node',
  '"%NODE%" "%KIT%HarnessHub\scripts\competition-offline.mjs" setup %*',
  'exit /b %ERRORLEVEL%',
  ':missing_node',
  'echo [HarnessHub] Bundled Node was not found: "%NODE%" 1>&2',
  'echo [HarnessHub] Run this file from the root of the extracted offline kit. 1>&2',
  'exit /b 2'
)
Write-CrlfFile (Join-Path $Kit "Start-Competition.cmd") @(
  '@echo off',
  'setlocal',
  'set "KIT=%~dp0"',
  'set "BUNDLE=%KIT%competition"',
  'if not exist "%BUNDLE%\gateway.cmd" goto missing_layout',
  'if not defined AGENT_ENGINE goto missing_engine',
  'call "%BUNDLE%\gateway.cmd" %*',
  'exit /b %ERRORLEVEL%',
  ':missing_layout',
  'echo [HarnessHub] Competition layout not found: "%BUNDLE%" 1>&2',
  'echo [HarnessHub] Run Setup-Competition-Offline.cmd first. 1>&2',
  'exit /b 2',
  ':missing_engine',
  'echo [HarnessHub] AGENT_ENGINE is not set. PowerShell example: $env:AGENT_ENGINE = "opencode" 1>&2',
  '"%BUNDLE%\runtime\node.exe" "%KIT%HarnessHub\scripts\competition-offline.mjs" engines --bundle "%BUNDLE%" 1>&2',
  'exit /b 2'
)

Copy-Item -LiteralPath (Join-Path $Repo "distribution\INSTRUCTION.md") -Destination (Join-Path $Kit "INSTRUCTION.md")

Write-Utf8File (Join-Path $Kit "README-OFFLINE.md") @'
# HarnessHub Offline Development Kit (Windows x64)

Editable HarnessHub source plus everything needed to rebuild it and produce the runnable
competition layout **without network access**. The judge-facing procedure is in
`INSTRUCTION.md` (same file as `HarnessHub/distribution/INSTRUCTION.md`).

## Included
- `HarnessHub/`: editable source with self-contained Windows x64 `node_modules` (pnpm hoisted, copied files).
- `tools/node/`: Node 24.20.0 x64. `tools/pnpm-runner/`: pnpm 10.12.3.
- `pnpm-store/`: offline pnpm store used when `node_modules` must be restored.
- `prepared/win32-x64/`: fixed engine runtime payload (open-source edition) used by the competition layout.
- `engine-sources/`, `published-engine-packages/`, `engine-source-manifest.json`: upstream source snapshots and traceability.
- `Setup-Competition-Offline.cmd`: offline restore (only when needed) + build + package + no-model startup self-test; writes `competition\`.
- `Start-Competition.cmd`: starts `competition\gateway.cmd`; requires `AGENT_ENGINE`; passes `--port` / `--host` through.
- `Build-HarnessHub.cmd`, `Test-HarnessHub.cmd`, `Reinstall-Offline.cmd`: developer loop.

## Competition quick start (PowerShell, in this directory)
1. `.\Setup-Competition-Offline.cmd` (5-15 minutes; exit code 0 and a `competition.setup.completed` line mean success; log under `logs\`).
2. Set the unified model: `$env:HARNESSHUB_MODEL`, `$env:HARNESSHUB_MODEL_BASE_URL`, `$env:HARNESSHUB_MODEL_API_KEY`.
3. `$env:AGENT_ENGINE = "opencode"` then `.\Start-Competition.cmd` and keep the window open.

Setup never downloads: npm/pnpm run offline against an unreachable registry and proxy, so a
missing dependency fails with an error instead of reaching the network. Re-running Setup
keeps the previous layout as `competition.previous-<time>`.

## Packaging solution.zip
```
solution\INSTRUCTION.md   <- copy of INSTRUCTION.md from this directory
solution\code\            <- the complete contents of this directory
```
Create it from a clean extraction (no `competition\`, `logs\` or `competition.*` folders), in
the directory that contains the extracted kit folder `KIT`, for example:
```
robocopy KIT solution\code /E /R:1 /W:1
Copy-Item solution\code\INSTRUCTION.md solution\INSTRUCTION.md
tar.exe -a -c -f solution.zip solution
```
robocopy exit codes 0-7 mean success.

## Offline edit/build cycle
1. Edit `HarnessHub/src` (or tests/scripts).
2. `Build-HarnessHub.cmd`; `Test-HarnessHub.cmd` when needed.
3. `Setup-Competition-Offline.cmd` again to rebuild the competition layout from the edited source.
4. If `node_modules` is removed, `Reinstall-Offline.cmd` restores it from `pnpm-store` with `--offline`.

The authoritative engine list is `HarnessHub/distribution/open-source-edition.json`; exact versions are pinned by
`distribution/npm/package.json`, `binary-sources.json` and `extra-engine-sources.json`.
'@

Write-Host "Offline source kit assembled: $Kit"
