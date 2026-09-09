param(
  [Parameter(Mandatory = $true)][string]$Prepared,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$sourcePath = Join-Path $PSScriptRoot "build-offline-source-kit.ps1"
$generatedPath = Join-Path $PSScriptRoot "build-offline-source-kit.generated.ps1"
$source = Get-Content -LiteralPath $sourcePath -Raw

$pattern = '(?s)function Add-GitTagSnapshot\(\[string\]\$Id,\[string\]\$Repository,\[string\[\]\]\$Refs,\[string\]\$PreparedRelative\) \{.*?Add-GitTagSnapshot "opencode" "https://github\.com/anomalyco/opencode\.git" @\("v1\.18\.29","1\.18\.29"\) "engines\\opencode"'

$replacement = @'
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
'@

$patched = [regex]::Replace($source, $pattern, $replacement, 1)
if ($patched -eq $source) {
  throw "Native source snapshot block was not found; update run-offline-source-kit.ps1 for the new source layout"
}

try {
  Set-Content -LiteralPath $generatedPath -Value $patched -Encoding UTF8
  & $generatedPath -Prepared $Prepared -Output $Output
  if ($LASTEXITCODE -ne 0) { throw "Offline source kit assembly failed" }
} finally {
  Remove-Item -LiteralPath $generatedPath -Force -ErrorAction SilentlyContinue
}
