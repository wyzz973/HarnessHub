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

$regex = [regex]::new($pattern)
$evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
  param($match)
  return $replacement
}
$patched = $regex.Replace($source, $evaluator, 1)
if ($patched -eq $source) {
  throw "Native source snapshot block was not found; update run-offline-source-kit.ps1 for the new source layout"
}

# `pip download` evaluates Requires-Python against the hosted runner. Hermes 0.19.0
# deliberately targets Python <3.14, while the latest GitHub Windows image may expose
# Python 3.14 as `py -3`. Download the exact sdist selected by PyPI metadata instead.
$hermesPattern = 'py -3 -m pip download --no-deps --no-binary=:all: "hermes-agent==0\.19\.0" --dest \$HermesPublished\r?\nif \(\$LASTEXITCODE -ne 0\) \{ throw "Failed to download exact Hermes source distribution" \}'
$hermesReplacement = @'
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
'@
$hermesRegex = [regex]::new($hermesPattern)
$hermesEvaluator = [System.Text.RegularExpressions.MatchEvaluator]{
  param($match)
  return $hermesReplacement
}
$hermesPatched = $hermesRegex.Replace($patched, $hermesEvaluator, 1)
if ($hermesPatched -eq $patched) {
  throw "Hermes source download block was not found; update run-offline-source-kit.ps1 for the new source layout"
}
$patched = $hermesPatched

# pnpm store path includes its layout version (for pnpm 10 this is typically `...\v10`).
# `--store-dir` expects the parent store root and appends that version internally, so keep
# the version directory inside the portable kit instead of flattening its contents.
$storePattern = 'Copy-Tree \$StorePath \(Join-Path \$Kit "pnpm-store"\)'
$storeReplacement = @'
$StoreVersion = Split-Path $StorePath -Leaf
$PortableStore = Join-Path $Kit "pnpm-store\$StoreVersion"
Copy-Tree $StorePath $PortableStore
'@
$storeRegex = [regex]::new($storePattern)
$storeEvaluator = [System.Text.RegularExpressions.MatchEvaluator]{
  param($match)
  return $storeReplacement
}
$storePatched = $storeRegex.Replace($patched, $storeEvaluator, 1)
if ($storePatched -eq $patched) {
  throw "pnpm store copy block was not found; update run-offline-source-kit.ps1 for the new source layout"
}
$patched = $storePatched

try {
  Set-Content -LiteralPath $generatedPath -Value $patched -Encoding UTF8
  & $generatedPath -Prepared $Prepared -Output $Output
  if ($LASTEXITCODE -ne 0) { throw "Offline source kit assembly failed" }
} finally {
  Remove-Item -LiteralPath $generatedPath -Force -ErrorAction SilentlyContinue
}
