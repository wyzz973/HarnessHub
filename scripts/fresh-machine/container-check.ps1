# Runs inside a clean Windows container (Server Core, Windows PowerShell 5.1, no network):
# proves that the released competition bundle works on a machine with nothing installed.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
#
# It records what the machine lacks, extracts the ZIP with the system's own tar.exe, copies
# the repository scripts next to it and, using only the bundle's runtime\node.exe, runs
# `hub.cmd doctor --full`, the no-model self-test (includes the console HTTP 200 check), the
# static native dependency scan and the mock-model engine matrix. Round "unicode" repeats the
# dynamic checks after moving the bundle to a path with a space and Chinese characters.
# Results go to <OutMount>; the exit code is 0 only when every check passed.
param(
  [Parameter(Mandatory = $true)][string]$ZipFile,
  [Parameter(Mandatory = $true)][string]$ScriptsSource,
  [Parameter(Mandatory = $true)][string]$OutMount,
  [string]$Engines = "opencode,codex,qwen,hermes,pi,gemini,mimo,dsh,openclaw,kimi",
  [string]$UnicodeEngines = "",
  [string]$ReferenceList = "",
  [string]$Rounds = "plain,unicode",
  [string]$OverlayDirectory = "",
  [int]$MatrixTimeoutMinutes = 55
)
$ErrorActionPreference = "Stop"
$work = "C:\fm"
$out = Join-Path $work "out"
$scripts = Join-Path $work "scripts"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$results = New-Object System.Collections.ArrayList
$extractSeconds = $null

function Join-Arguments([string[]]$values) {
  return ($values | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join " "
}

# Start-Process keeps stderr as text (PowerShell 5.1 would turn it into error records) and
# gives a reliable exit code; a timeout ends the whole process tree. $ArgumentLine is passed
# verbatim so cmd.exe quoting stays under the caller's control.
function Invoke-Check([string]$Round, [string]$Name, [string]$File, [string]$ArgumentLine, [string]$Log, [int]$TimeoutMinutes) {
  $started = Get-Date
  Write-Host "[$Round] $Name ..."
  $process = Start-Process -FilePath $File -ArgumentList $ArgumentLine -NoNewWindow -PassThru `
    -RedirectStandardOutput "$Log.stdout.log" -RedirectStandardError "$Log.stderr.log"
  $handle = $process.Handle
  $timedOut = -not $process.WaitForExit($TimeoutMinutes * 60 * 1000)
  if ($timedOut) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
    $code = -1
  } else {
    $process.WaitForExit()
    $code = $process.ExitCode
  }
  $seconds = [int]((Get-Date) - $started).TotalSeconds
  $status = "FAIL"
  if (-not $timedOut -and $code -eq 0) { $status = "PASS" }
  Write-Host "[$Round] $Name -> $status (exit $code, $seconds s)"
  [void]$results.Add([ordered]@{ round = $Round; check = $Name; status = $status; exitCode = $code; timedOut = $timedOut; seconds = $seconds; log = (Split-Path $Log -Leaf) })
}

function Test-Tcp([string]$Address, [int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect($Address, $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(3000)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch { return $false } finally { $client.Close() }
}

$prepared = $false
try {
  # ---- 1. What this machine lacks -------------------------------------------------------------
  $system32 = Join-Path $env:SystemRoot "System32"
  $current = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
  $runtimeDlls = [ordered]@{}
  foreach ($dll in @("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "concrt140.dll", "vcomp140.dll", "msvcr120.dll", "msvcr100.dll", "ucrtbase.dll")) {
    $runtimeDlls[$dll] = Test-Path -LiteralPath (Join-Path $system32 $dll)
  }
  $tools = [ordered]@{}
  foreach ($tool in @("node", "npm", "pnpm", "git", "bash", "python", "py", "pwsh", "java", "dotnet", "code")) {
    $found = & $env:ComSpec /d /c "where $tool 2>nul"
    if ($LASTEXITCODE -eq 0) { $tools[$tool] = @($found)[0] } else { $tools[$tool] = $null }
  }
  $vcKeys = @("HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64")
  $vcInstalled = $false
  foreach ($key in $vcKeys) { if (Test-Path $key) { $vcInstalled = $true } }
  $addresses = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object {
      $name = $_.Name
      $_.GetIPProperties().UnicastAddresses | ForEach-Object { "$name $($_.Address)" }
    })
  $environment = [ordered]@{
    product = $current.ProductName
    installationType = $current.InstallationType
    build = "$($current.CurrentBuild).$($current.UBR)"
    powershell = $PSVersionTable.PSVersion.ToString()
    ansiCodePage = [System.Text.Encoding]::Default.CodePage
    user = "$env:USERDOMAIN\$env:USERNAME"
    system32RuntimeDlls = $runtimeDlls
    vcRedistributableRegistered = $vcInstalled
    toolsOnPath = $tools
    networkAddresses = $addresses
    internetReachable = (Test-Tcp "1.1.1.1" 443) -or (Test-Tcp "140.82.112.3" 443)
    loopbackV4 = $null
  }
  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $environment.loopbackV4 = Test-Tcp "127.0.0.1" ([int]$listener.LocalEndpoint.Port)
  $listener.Stop()
  $environment | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $out "environment.json")
  Write-Host "==== Clean machine evidence ===="
  Get-Content (Join-Path $out "environment.json") | Write-Host
  Get-ChildItem -LiteralPath $system32 -Filter *.dll -Name | Set-Content -Encoding ASCII (Join-Path $out "clean-system32-dlls.txt")

  # ---- 2. Extract like a user would, with what Windows ships ----------------------------------
  $bundle = "C:\hh"
  New-Item -ItemType Directory -Force -Path $bundle | Out-Null
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZipFile).Hash.ToLowerInvariant()
  $expected = ((Get-Content -Raw -LiteralPath "$ZipFile.sha256").Trim() -split '\s+')[0].ToLowerInvariant()
  if ($hash -ne $expected) { throw "ZIP SHA-256 mismatch inside the container: $hash" }
  $extractStarted = Get-Date
  & "$env:SystemRoot\System32\tar.exe" -xf $ZipFile -C $bundle
  if ($LASTEXITCODE -ne 0) { throw "tar.exe could not extract the bundle (exit $LASTEXITCODE)" }
  $extractSeconds = [int]((Get-Date) - $extractStarted).TotalSeconds
  Write-Host "Extracted with tar.exe in $extractSeconds s"
  if ($OverlayDirectory -and (Test-Path -LiteralPath $OverlayDirectory)) {
    # Candidate fixes are applied as plain file overlays so the same change can be proven
    # before it is built into a release.
    & "$env:SystemRoot\System32\robocopy.exe" $OverlayDirectory $bundle /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Overlay copy failed (robocopy $LASTEXITCODE)" }
    Write-Host "Applied overlay from $OverlayDirectory"
  }
  & "$env:SystemRoot\System32\robocopy.exe" $ScriptsSource $scripts /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Could not copy the repository scripts (robocopy $LASTEXITCODE)" }
  $node = Join-Path $bundle "runtime\node.exe"
  if (-not (Test-Path -LiteralPath $node)) { throw "The bundle has no runtime\node.exe" }

  $prepared = $true
} catch {
  Write-Host "PREPARATION FAILED: $($_.Exception.Message)"
  [void]$results.Add([ordered]@{ round = "prepare"; check = "extract-and-inspect"; status = "FAIL"; exitCode = -1; timedOut = $false; seconds = 0; log = $_.Exception.Message })
}

# ---- 3. Checks ------------------------------------------------------------------------------
$unicodeName = [string][char]0x8BC4 + [char]0x6D4B + " " + [char]0x76EE + [char]0x5F55
try {
  if (-not $prepared) { $Rounds = "" }
  foreach ($round in ($Rounds -split "," | Where-Object { $_ })) {
    $roundOut = Join-Path $out $round
    New-Item -ItemType Directory -Force -Path $roundOut | Out-Null
    $roundEngines = $Engines
    if ($round -eq "unicode") {
      # A fresh extraction is what the documentation asks for; moving the directory after
      # removing the run data is equivalent and avoids a second multi-gigabyte extraction.
      try {
        $state = Join-Path $bundle "state"
        if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Recurse -Force }
        $parent = Join-Path "C:\" $unicodeName
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        $moved = Join-Path $parent "hh"
        Move-Item -LiteralPath $bundle -Destination $moved
        $bundle = $moved
        $node = Join-Path $bundle "runtime\node.exe"
      } catch {
        Write-Host "[$round] relocate -> FAIL: $($_.Exception.Message)"
        [void]$results.Add([ordered]@{ round = $round; check = "relocate"; status = "FAIL"; exitCode = -1; timedOut = $false; seconds = 0; log = $_.Exception.Message })
        continue
      }
      if ($UnicodeEngines) { $roundEngines = $UnicodeEngines }
    }
    Write-Host "==== Round $round : $bundle ===="
    $hub = Join-Path $bundle "hub.cmd"
    Invoke-Check $round "doctor-full" $env:ComSpec "/d /s /c `"`"$hub`" doctor --full`"" (Join-Path $roundOut "doctor") 20
    Invoke-Check $round "selftest" $node (Join-Arguments @((Join-Path $scripts "competition-selftest.mjs"), "--bundle", $bundle, "--engine", "opencode", "--out", (Join-Path $roundOut "selftest.json"), "--log", (Join-Path $roundOut "selftest-gateway.log"))) (Join-Path $roundOut "selftest") 15
    if ($round -eq "plain") {
      $scan = @((Join-Path $scripts "check-bundle-native-deps.mjs"), "--root", $bundle, "--system32", $system32, "--out", (Join-Path $roundOut "native-deps.json"), "--summary", (Join-Path $roundOut "native-deps.md"), "--strict")
      if ($ReferenceList -and (Test-Path -LiteralPath $ReferenceList)) { $scan += @("--reference-list", $ReferenceList) }
      Invoke-Check $round "native-deps" $node (Join-Arguments $scan) (Join-Path $roundOut "native-deps") 20
    }
    $matrixOut = Join-Path $roundOut "matrix"
    Invoke-Check $round "engine-matrix" $node (Join-Arguments @((Join-Path $scripts "competition-matrix.mjs"), "--bundle", $bundle, "--engines", $roundEngines, "--out", $matrixOut, "--mock", "--mock-quirks", "--with-console", "--engine-timeout-ms", "420000", "--summary", (Join-Path $roundOut "matrix-summary.md"))) (Join-Path $roundOut "matrix-run") $MatrixTimeoutMinutes
  }
} catch {
  Write-Host "UNEXPECTED: $($_.Exception.Message)"
  [void]$results.Add([ordered]@{ round = "script"; check = "unexpected-error"; status = "FAIL"; exitCode = -1; timedOut = $false; seconds = 0; log = $_.Exception.Message })
}

# ---- 4. Hand the evidence to the host -------------------------------------------------------
$failed = @($results | Where-Object { $_.status -ne "PASS" })
$summary = [ordered]@{ status = "PASS"; extractSeconds = $extractSeconds; checks = $results }
if (-not $results.Count) { $summary.status = "FAIL" }
if ($failed.Count) { $summary.status = "FAIL" }
$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $out "result.json")
& "$env:SystemRoot\System32\robocopy.exe" $out $OutMount /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "WARNING: copying results to the host failed (robocopy $LASTEXITCODE)" }
Write-Host "==== Result: $($summary.status) ===="
$results | ForEach-Object { Write-Host ("{0,-8} {1,-14} {2} (exit {3}, {4} s)" -f $_.round, $_.check, $_.status, $_.exitCode, $_.seconds) }
if ($summary.status -ne "PASS") { exit 1 }
exit 0
