# Debug-only: while a Hermes run is active, snapshot the related process tree and dump the
# Python stacks of every bundled Hermes interpreter with py-spy every 8 seconds.
param([string]$Bundle, [string]$Out, [int]$Seconds = 300, [int]$WatchPid = 0)
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$pyspy = (Get-Command py-spy -ErrorAction SilentlyContinue).Source
$deadline = (Get-Date).AddSeconds($Seconds)
$index = 0
while ((Get-Date) -lt $deadline) {
  $index++
  $stamp = Get-Date -Format "HH:mm:ss"
  $rows = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and ($_.CommandLine -like "*$Bundle*" -or $_.Name -match '^(bash|sh|true|cat|conhost)\.exe$')
  } | Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine
  "=== $stamp snapshot $index" | Out-File -Append -FilePath "$Out\process-snapshots.txt" -Encoding utf8
  $rows | Format-List | Out-String -Width 500 | Out-File -Append -FilePath "$Out\process-snapshots.txt" -Encoding utf8
  foreach ($row in ($rows | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*engines\hermes*' })) {
    "=== $stamp py-spy pid $($row.ProcessId)" | Out-File -Append -FilePath "$Out\py-spy.txt" -Encoding utf8
    if ($pyspy) {
      & $pyspy dump --pid $row.ProcessId 2>&1 | Out-File -Append -FilePath "$Out\py-spy.txt" -Encoding utf8
      & $pyspy dump --native --pid $row.ProcessId 2>&1 | Out-File -Append -FilePath "$Out\py-spy-native.txt" -Encoding utf8
    }
  }
  if ($WatchPid -and -not (Get-Process -Id $WatchPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 8
}
