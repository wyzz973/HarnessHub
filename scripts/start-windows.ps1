# Run from any directory; use the repository-local pinned runtime when installed.
$ErrorActionPreference = 'Stop'
$repoDirectory = Split-Path -Parent $PSScriptRoot
$nodeVersion = (Get-Content -LiteralPath (Join-Path $repoDirectory '.node-version') -Raw).Trim()
$nativeArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$localNode = Join-Path $repoDirectory ".tools\node-v$nodeVersion-win-$nativeArchitecture\node.exe"
$runtimeCommand = if (Test-Path -LiteralPath $localNode) { $localNode } else { (Get-Command node -ErrorAction Stop).Source }
Push-Location -LiteralPath $repoDirectory
try { & $runtimeCommand 'scripts/start-local.mjs' @args; exit $LASTEXITCODE }
finally { Pop-Location }
