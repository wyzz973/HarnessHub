# Debug-only: while a Gemini acceptance runs, record the process tree under $WatchPid every
# 5 seconds (JSON lines) and, once the mock has issued the shell tool call and no tool result
# followed for 40 s, dump the Gemini engine process (libuv handles + JS stack) via node_dump.mjs.
param([int]$WatchPid, [string]$Out, [string]$MockLog, [string]$Node, [string]$Dump, [int]$Seconds = 480)
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$deadline = (Get-Date).AddSeconds($Seconds)
$toolCallSeen = $null
$dumps = 0
while ((Get-Date) -lt $deadline) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
  $tree = New-Object System.Collections.ArrayList
  $frontier = @($WatchPid)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($row in $all) {
      if ($frontier -contains [int]$row.ParentProcessId -and -not ($tree | Where-Object { $_.ProcessId -eq $row.ProcessId })) {
        [void]$tree.Add($row); $next += [int]$row.ProcessId
      }
    }
    $frontier = $next
  }
  @{ at = (Get-Date).ToString("o"); tree = $tree } | ConvertTo-Json -Depth 4 -Compress | Out-File -Append -FilePath "$Out\tree.jsonl" -Encoding utf8
  if ($dumps -lt 2 -and (Test-Path $MockLog)) {
    $lines = @(Get-Content $MockLog)
    if (-not $toolCallSeen -and ($lines -match '"turn":"tool-call"')) { $toolCallSeen = Get-Date }
    $answered = [bool]($lines -match '"turn":"tool-result"')
    if ($toolCallSeen -and -not $answered -and ((Get-Date) - $toolCallSeen).TotalSeconds -ge (40 + 60 * $dumps)) {
      $gemini = @($tree | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*gemini.js*' })
      $inner = $gemini | Where-Object { $parent = $_.ParentProcessId; $gemini | Where-Object { $_.ProcessId -eq $parent } } | Select-Object -First 1
      if (-not $inner) { $inner = $gemini | Select-Object -Last 1 }
      if ($inner) {
        "=== dump $dumps of pid $($inner.ProcessId): $($inner.CommandLine)" | Out-File -Append "$Out\dump.log" -Encoding utf8
        & $Node $Dump $inner.ProcessId "$Out\gemini-dump-$dumps.json" 9229 2>&1 | Out-File -Append "$Out\dump.log" -Encoding utf8
      }
      $dumps++
    }
  }
  if (-not (Get-Process -Id $WatchPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 5
}
