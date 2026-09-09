param(
  [Parameter(Mandatory = $true)][string]$Prepared,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Prepared = (Resolve-Path $Prepared).Path
$Kit = [System.IO.Path]::GetFullPath($Output)
Remove-Item -Recurse -Force $Kit -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Kit | Out-Null

function Copy-Tree([string]$Source, [string]$Target) {
  robocopy $Source $Target /E /R:2 /W:1 *> $null
  if ($LASTEXITCODE -gt 7) { throw "robocopy failed: $Source -> $Target ($LASTEXITCODE)" }
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

$HarnessHub = Join-Path $Kit "HarnessHub"
New-Item -ItemType Directory -Force -Path $HarnessHub | Out-Null
robocopy $Repo $HarnessHub /E /R:2 /W:1 /XD .git .tools .artifact-x64 .artifact-offline-source node_modules /XF *.zip *.7z *> $null
if ($LASTEXITCODE -gt 7) { throw "Failed to copy HarnessHub source" }
Copy-Tree (Join-Path $Repo "node_modules") (Join-Path $HarnessHub "node_modules")

$Tools = Join-Path $Kit "tools"
New-Item -ItemType Directory -Force -Path (Join-Path $Tools "node") | Out-Null
$Node = (Get-Command node).Source
Copy-Item -LiteralPath $Node -Destination (Join-Path $Tools "node\node.exe")
$NodeLicense = Join-Path (Split-Path $Node) "LICENSE"
if (Test-Path $NodeLicense) { Copy-Item $NodeLicense (Join-Path $Tools "node\LICENSE") }
Copy-Tree (Join-Path $Repo ".tools\pnpm-runner") (Join-Path $Tools "pnpm-runner")

$StorePath = (pnpm store path).Trim()
Copy-Tree $StorePath (Join-Path $Kit "pnpm-store")
Copy-Tree $Prepared (Join-Path $Kit "prepared\win32-x64")

$SourceRoot = Join-Path $Kit "engine-sources"
$PublishedRoot = Join-Path $Kit "published-engine-packages"
New-Item -ItemType Directory -Force -Path $SourceRoot,$PublishedRoot | Out-Null
$Manifest = New-Object System.Collections.Generic.List[object]

function Add-NpmSnapshot([string]$Id,[string]$Spec,[string]$InstalledRelative) {
  Write-Host "Source snapshot: $Id <- $Spec"
  $Meta = npm view $Spec --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "npm metadata lookup failed: $Spec" }
  $RepoValue = if ($Meta.repository -is [string]) { $Meta.repository } elseif ($Meta.repository) { $Meta.repository.url } else { $null }
  $Upstream = Normalize-Repo $RepoValue
  $GitHead = [string]$Meta.gitHead
  $Destination = Join-Path $SourceRoot $Id
  $Snapshot = "published-package-only"

  if ($Upstream -and $GitHead) {
    try {
      git clone --filter=blob:none --no-checkout $Upstream $Destination
      if ($LASTEXITCODE -ne 0) { throw "clone failed" }
      git -C $Destination fetch --depth 1 origin $GitHead
      if ($LASTEXITCODE -ne 0) { throw "fetch gitHead failed" }
      git -C $Destination checkout --detach $GitHead
      if ($LASTEXITCODE -ne 0) { throw "checkout gitHead failed" }
      Remove-Item -Recurse -Force (Join-Path $Destination ".git")
      $Snapshot = "gitHead"
    } catch {
      Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
      Write-Warning "$Id exact repository snapshot unavailable; published package is retained. $($_.Exception.Message)"
    }
  }

  $Installed = Join-Path $Prepared $InstalledRelative
  if (-not (Test-Path $Installed)) { throw "Prepared package missing: $Id ($Installed)" }
  Copy-Tree $Installed (Join-Path $PublishedRoot $Id)
  $Manifest.Add([pscustomobject]@{
    id = $Id
    package = $Spec
    repository = $Upstream
    gitHead = $GitHead
    snapshot = $Snapshot
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

function Add-GitTagSnapshot([string]$Id,[string]$Repository,[string[]]$Refs,[string]$PreparedRelative) {
  $Destination = Join-Path $SourceRoot $Id
  $Used = $null
  foreach ($Ref in $Refs) {
    Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
    git clone --depth 1 --branch $Ref $Repository $Destination
    if ($LASTEXITCODE -eq 0) { $Used = $Ref; break }
  }
  if (-not $Used) { throw "Unable to snapshot $Id from $Repository" }
  Remove-Item -Recurse -Force (Join-Path $Destination ".git")
  $Installed = Join-Path $Prepared $PreparedRelative
  if (-not (Test-Path $Installed)) { throw "Prepared native engine missing: $Id" }
  Copy-Tree $Installed (Join-Path $PublishedRoot $Id)
  $Manifest.Add([pscustomobject]@{
    id = $Id
    package = $null
    repository = $Repository
    gitHead = $null
    snapshot = "tag:$Used"
  })
}

Add-GitTagSnapshot "kimi" "https://github.com/MoonshotAI/kimi-cli.git" @("1.50.0","v1.50.0") "engines\kimi"
Add-GitTagSnapshot "opencode" "https://github.com/anomalyco/opencode.git" @("v1.18.29","1.18.29") "engines\opencode"

Write-Host "Source snapshot: hermes-agent==0.19.0"
$HermesMeta = Invoke-RestMethod "https://pypi.org/pypi/hermes-agent/0.19.0/json"
$HermesRepo = @($HermesMeta.info.project_urls.PSObject.Properties.Value + $HermesMeta.info.home_page) |
  Where-Object { $_ -match '^https://github.com/' } |
  Select-Object -First 1
$HermesSnapshot = "sdist"
if ($HermesRepo) {
  $HermesRepo = Normalize-Repo $HermesRepo
  $HermesDestination = Join-Path $SourceRoot "hermes"
  foreach ($Ref in @("v0.19.0","0.19.0")) {
    Remove-Item -Recurse -Force $HermesDestination -ErrorAction SilentlyContinue
    git clone --depth 1 --branch $Ref $HermesRepo $HermesDestination
    if ($LASTEXITCODE -eq 0) {
      Remove-Item -Recurse -Force (Join-Path $HermesDestination ".git")
      $HermesSnapshot = "tag:$Ref"
      break
    }
  }
}
$HermesPublished = Join-Path $PublishedRoot "hermes"
New-Item -ItemType Directory -Force -Path $HermesPublished | Out-Null
py -3 -m pip download --no-deps --no-binary=:all: "hermes-agent==0.19.0" --dest $HermesPublished
if ($LASTEXITCODE -ne 0) { throw "Failed to download exact Hermes source distribution" }
Copy-Tree (Join-Path $Prepared "engines\hermes") (Join-Path $PublishedRoot "hermes-runtime")
$Manifest.Add([pscustomobject]@{
  id = "hermes"
  package = "hermes-agent==0.19.0"
  repository = $HermesRepo
  gitHead = $null
  snapshot = $HermesSnapshot
})

$Manifest | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 (Join-Path $Kit "engine-source-manifest.json")
git -C $Repo rev-parse HEAD | Set-Content -Encoding Ascii (Join-Path $Kit "HARNESSHUB_COMMIT.txt")

@'
@echo off
setlocal
set ROOT=%~dp0
set NODE=%ROOT%tools\node\node.exe
set PNPM=%ROOT%tools\pnpm-runner\node_modules\pnpm\bin\pnpm.cjs
cd /d "%ROOT%HarnessHub"
"%NODE%" "%PNPM%" build
exit /b %ERRORLEVEL%
'@ | Set-Content -Encoding Ascii (Join-Path $Kit "Build-HarnessHub.cmd")

@'
@echo off
setlocal
set ROOT=%~dp0
set NODE=%ROOT%tools\node\node.exe
set PNPM=%ROOT%tools\pnpm-runner\node_modules\pnpm\bin\pnpm.cjs
cd /d "%ROOT%HarnessHub"
"%NODE%" "%PNPM%" test
exit /b %ERRORLEVEL%
'@ | Set-Content -Encoding Ascii (Join-Path $Kit "Test-HarnessHub.cmd")

@'
@echo off
setlocal
set ROOT=%~dp0
set NODE=%ROOT%tools\node\node.exe
set PNPM=%ROOT%tools\pnpm-runner\node_modules\pnpm\bin\pnpm.cjs
cd /d "%ROOT%HarnessHub"
if exist node_modules rmdir /s /q node_modules
"%NODE%" "%PNPM%" install --offline --frozen-lockfile --store-dir "%ROOT%pnpm-store"
exit /b %ERRORLEVEL%
'@ | Set-Content -Encoding Ascii (Join-Path $Kit "Reinstall-Offline.cmd")

@'
# HarnessHub Offline Development Kit (Windows x64)

This is an editable source workspace, not a prebuilt Competition Bundle.

## Included
- `HarnessHub/`: editable HarnessHub source plus resolved Windows x64 `node_modules`.
- `prepared/win32-x64/`: the fixed open-source engine runtime payload used by the Competition edition, kept separate from HarnessHub source.
- `engine-sources/`: exact upstream repository snapshots where package metadata/tags allow it.
- `published-engine-packages/`: exact installed package/native runtime contents; Hermes also includes the exact 0.19.0 source distribution.
- `pnpm-store/`: offline store for reinstalling HarnessHub dependencies.
- `tools/node/`: Node 24.20.0 x64.
- `tools/pnpm-runner/`: pnpm 10.12.3.

## Offline edit/build cycle
1. Edit `HarnessHub/src` (or tests/scripts).
2. Run `Build-HarnessHub.cmd`.
3. Run `Test-HarnessHub.cmd` when needed.
4. If `node_modules` is removed, run `Reinstall-Offline.cmd`; it uses the included pnpm store with `--offline`.

## Engine source/version traceability
See `engine-source-manifest.json`. The authoritative Competition engine list remains `HarnessHub/distribution/open-source-edition.json`; exact package/binary versions remain pinned by `distribution/npm/package.json`, `binary-sources.json`, and `extra-engine-sources.json`.

`engine-sources/` is for reading/editing/reference. `prepared/win32-x64/` is the known fixed runtime payload so normal HarnessHub source edits do not require rebuilding all upstream engines.

## Optional local packaging
This kit intentionally does not prebuild a Competition Bundle. After editing HarnessHub, you can choose to run the existing repository packaging scripts against `prepared/win32-x64`; the engine payload is already local.

## Known OpenCode Full Access investigation
The current source revision still contains the Competition `OPENCODE_PERMISSION` launcher injection. Local A/B testing showed: Safe=204, Full=driver_error; removing that injection made Full=204. Treat that as a known source fix to apply while editing Full Access behavior.
'@ | Set-Content -Encoding UTF8 (Join-Path $Kit "README-OFFLINE.md")

Write-Host "Offline source kit assembled: $Kit"
