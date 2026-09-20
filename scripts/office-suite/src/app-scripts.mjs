// Windows PowerShell 5.1 sources of the app tools. Kept apart from app.mjs so that the
// Windows CI test can parse every script with the PowerShell parser.

export const FUNCTIONS = String.raw`
function Expand($value) { return [Environment]::ExpandEnvironmentVariables([string]$value) }
function Find-Exe($spec) {
  foreach ($candidate in @($spec.paths | Where-Object { $_ })) {
    $expanded = Expand $candidate
    if ($expanded -and (Test-Path -LiteralPath $expanded -PathType Leaf)) { return $expanded }
  }
  $roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')
  foreach ($exe in @($spec.exe | Where-Object { $_ })) {
    foreach ($root in $roots) {
      $key = Join-Path $root $exe
      if (Test-Path -LiteralPath $key) {
        $value = (Get-Item -LiteralPath $key).GetValue('')
        if ($value) {
          $value = (Expand $value).Trim('"')
          if (Test-Path -LiteralPath $value -PathType Leaf) { return $value }
        }
      }
    }
  }
  foreach ($exe in @($spec.exe | Where-Object { $_ })) {
    $command = Get-Command -Name $exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
  }
  return $null
}
function Find-Shortcut($patterns) {
  $folders = @((Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
  foreach ($pattern in @($patterns | Where-Object { $_ })) {
    foreach ($folder in $folders) {
      if (-not (Test-Path -LiteralPath $folder)) { continue }
      $link = Get-ChildItem -LiteralPath $folder -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -like $pattern } | Select-Object -First 1
      if ($link) { return $link.FullName }
    }
  }
  return $null
}
$script:startApps = $null
function Find-StartApp($patterns) {
  if ($null -eq $script:startApps) {
    try { $script:startApps = @(Get-StartApps) } catch { $script:startApps = @() }
  }
  foreach ($pattern in @($patterns | Where-Object { $_ })) {
    $entry = $script:startApps | Where-Object { $_.Name -like $pattern -or $_.AppID -like $pattern } | Select-Object -First 1
    if ($entry) { return $entry }
  }
  return $null
}
function Get-Running($names) {
  $result = @()
  foreach ($name in @($names | Where-Object { $_ })) {
    $result += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  }
  return ,$result
}
function Describe($processes) {
  return ,@($processes | Sort-Object Id -Unique | Select-Object -First 12 | ForEach-Object { @{ name = $_.ProcessName; pid = $_.Id; title = [string]$_.MainWindowTitle; window = ($_.MainWindowHandle -ne 0) } })
}
function Test-DesktopShell {
  $session = (Get-Process -Id $PID).SessionId
  return [bool](Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session })
}
function Count-FolderWindows {
  try { return @((New-Object -ComObject Shell.Application).Windows()).Count } catch { return 0 }
}
`;

export const OPEN = String.raw`
$spec = $in.spec
$target = $null
$kind = $null
$note = $null
if ($in.file) { $target = $in.file; $kind = 'file' }
elseif ($in.uri) { $target = $in.uri; $kind = 'uri' }
else {
  $exe = Find-Exe $spec
  if ($exe) { $target = $exe; $kind = 'exe' }
  else {
    $link = Find-Shortcut $spec.start
    if ($link) { $target = $link; $kind = 'shortcut' }
    else {
      $app = Find-StartApp $spec.start
      if ($app) { $target = 'shell:AppsFolder\' + $app.AppID; $kind = 'startapp'; $note = 'Start menu entry: ' + $app.Name }
      else {
        $uri = @($spec.uris | Where-Object { $_ }) | Select-Object -First 1
        if ($uri) { $target = $uri; $kind = 'uri' }
      }
    }
  }
}
if (-not $target) {
  Fail 'APP_NOT_FOUND' ('"' + $in.name + '" is not installed on this computer (no program file, Start menu entry or protocol was found).') 'Run app_list with a keyword to see what is installed, or pass the full path of the .exe.'
}
$arguments = $in.arguments
if ($in.with) {
  $opener = Find-Exe $in.with
  if (-not $opener) { Fail 'APP_NOT_FOUND' ('The application for --with was not found: ' + $in.withName) $null }
  $arguments = '"' + $target + '"'
  $target = $opener
  $kind = 'exe'
}
$names = @($spec.processes | Where-Object { $_ })
$before = @((Get-Running $names) | ForEach-Object { $_.Id })
$folderWindows = 0
if ($spec.folder) { $folderWindows = Count-FolderWindows }
$alreadyRunning = ($before.Count -gt 0) -and (-not $spec.folder) -and (-not $in.file) -and (-not $arguments)
$explorer = Join-Path $env:SystemRoot 'explorer.exe'
$methods = @()
if (-not $alreadyRunning) {
  # Brokers outside the agent's kill-on-close Job first; a direct child only as last resort.
  if ((-not $in.direct) -and (Test-DesktopShell)) { $methods += 'desktop-shell'; $methods += 'task' }
  if ((-not $in.direct) -and ($kind -eq 'exe')) { $methods += 'wmi' }
  $methods += 'child-process'
}
$launcherName = 'none'
$deadline = (Get-Date).AddSeconds([int]$in.timeout)
$found = @()
$windowed = $false
$method = 'none'
$attempt = 0
$wantTitle = [bool]($in.file -and $in.title)
do {
  $launcher = $null
  if ($methods.Count -gt 0) {
    $method = $methods[$attempt]
    if ($method -eq 'desktop-shell') {
      if ($arguments) {
        $launcher = Join-Path $env:TEMP ('hh-open-' + [guid]::NewGuid().ToString('N') + '.lnk')
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($launcher)
        $shortcut.TargetPath = $target
        $shortcut.Arguments = $arguments
        $shortcut.WorkingDirectory = (Get-Location).Path
        $shortcut.Save()
        Start-Process -FilePath $explorer -ArgumentList ('"' + $launcher + '"')
        $launcherName = 'shortcut'
      } else {
        # explorer.exe hands the target to the running desktop shell and exits with code 1.
        Start-Process -FilePath $explorer -ArgumentList ('"' + $target + '"')
        $launcherName = 'explorer'
      }
    } elseif ($method -eq 'task') {
      # One-shot interactive scheduled task: started by the Task Scheduler service.
      $taskName = 'HH-Open-' + [guid]::NewGuid().ToString('N')
      if ($kind -eq 'exe' -or $kind -eq 'shortcut') {
        $line = '\"' + $target + '\"'
        if ($arguments) { $line = $line + ' ' + ($arguments -replace '"', '\"') }
      } else { $line = '\"' + $explorer + '\" \"' + $target + '\"' }
      if ($line.Length -le 250) {
        # Native stderr plus ErrorActionPreference=Stop would abort Windows PowerShell 5.1.
        $ErrorActionPreference = 'Continue'
        try {
          & schtasks.exe /create /tn $taskName /sc once /st 00:00 /it /f /tr $line 2>&1 | Out-Null
          & schtasks.exe /run /tn $taskName 2>&1 | Out-Null
          Start-Sleep -Milliseconds 1500
          & schtasks.exe /delete /tn $taskName /f 2>&1 | Out-Null
        } finally { $ErrorActionPreference = 'Stop' }
        $launcherName = 'task'
      }
    } elseif ($method -eq 'wmi') {
      $line = '"' + $target + '"'
      if ($arguments) { $line = $line + ' ' + $arguments }
      [void](Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = (Get-Location).Path })
      $launcherName = 'wmi'
    } else {
      if ($kind -eq 'startapp' -or $kind -eq 'uri') { Start-Process -FilePath $explorer -ArgumentList ('"' + $target + '"') }
      elseif ($arguments) { Start-Process -FilePath $target -ArgumentList $arguments }
      else { Start-Process -FilePath $target }
      $launcherName = 'direct'
    }
  }
  # A later method only runs when this one produced no process within its share of the time.
  $share = $deadline
  if ($attempt -lt ($methods.Count - 1)) {
    $seconds = 5
    if ($attempt -eq 0) { $seconds = [Math]::Max(5, [int]($in.timeout / 2)) }
    $share = (Get-Date).AddSeconds($seconds)
    if ($share -gt $deadline) { $share = $deadline }
  }
  $firstSeen = $null
  $started = Get-Date
  do {
    Start-Sleep -Milliseconds 400
    if ($wantTitle) {
      $titled = @(Get-Process | Where-Object { $_.MainWindowTitle -like ('*' + $in.title + '*') })
      if ($titled.Count -gt 0) { $found = $titled; $windowed = $true; break }
    }
    if ($names.Count -gt 0) { $found = @(Get-Running $names) }
    if ($spec.folder) {
      if ((Count-FolderWindows) -gt $folderWindows) { $windowed = $true; break }
      if (((Get-Date) - $started).TotalSeconds -gt 6) { break }
    } elseif ($found.Count -gt 0) {
      if ($null -eq $firstSeen) { $firstSeen = Get-Date }
      if (@($found | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0) { $windowed = $true }
      $settled = ((Get-Date) - $firstSeen).TotalSeconds -gt 6
      if ($wantTitle) { if ($settled -and $windowed) { break } }
      elseif ($windowed -or $in.noWindow -or $settled) { break }
    } elseif ($names.Count -eq 0 -and -not $wantTitle) {
      if (((Get-Date) - $started).TotalSeconds -gt 2) { break }
    }
  } while ((Get-Date) -lt $share)
  if ($launcher) { Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue }
  $attempt++
} while ($found.Count -eq 0 -and $names.Count -gt 0 -and $attempt -lt $methods.Count -and (Get-Date) -lt $deadline)
if ($alreadyRunning) {
  try { [void](New-Object -ComObject WScript.Shell).AppActivate(($found | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id) } catch { }
}
$running = ($found.Count -gt 0)
if (-not $running -and $names.Count -eq 0) { $note = 'The target was handed to Windows; its process cannot be identified by name. Check app_list --windows.' }
$parents = @()
foreach ($process in @($found | Sort-Object Id -Unique | Select-Object -First 3)) {
  try {
    $info = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $process.Id)
    $parent = Get-Process -Id $info.ParentProcessId -ErrorAction SilentlyContinue
    if ($parent) { $parents += ($parent.ProcessName + ':' + $parent.Id) } else { $parents += ('exited:' + $info.ParentProcessId) }
  } catch { }
}
Write-Result @{
  ok = ($running -or $names.Count -eq 0 -or $spec.folder -eq $true)
  app = $in.name
  target = $target
  kind = $kind
  launcher = $launcherName
  inJob = ($launcherName -eq 'direct')
  alreadyRunning = $alreadyRunning
  running = $running
  window = $windowed
  processes = (Describe $found)
  parents = $parents
  note = $note
}
`;

export const CLOSE = String.raw`
$names = @($in.processes | Where-Object { $_ })
$found = @(Get-Running $names)
if ($found.Count -eq 0) { Write-Result @{ ok = $true; app = $in.name; wasRunning = $false; running = $false }; exit 0 }
foreach ($process in $found) { if ($process.MainWindowHandle -ne 0) { try { [void]$process.CloseMainWindow() } catch { } } }
$deadline = (Get-Date).AddSeconds(6)
do { Start-Sleep -Milliseconds 400; $left = @(Get-Running $names) } while ($left.Count -gt 0 -and (Get-Date) -lt $deadline)
$forced = $false
if ($left.Count -gt 0 -and $in.force) {
  foreach ($process in $left) { try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { } }
  Start-Sleep -Milliseconds 800
  $left = @(Get-Running $names)
  $forced = $true
}
$hint = $null
if ($left.Count -gt 0) { $hint = 'Still running: a save prompt may be waiting, or the process has no window. Use --force to end it (unsaved work is lost).' }
Write-Result @{ ok = $true; closed = ($left.Count -eq 0); app = $in.name; wasRunning = $true; running = ($left.Count -gt 0); forced = $forced; processes = (Describe $left); note = $hint }
`;

export const LIST = String.raw`
if ($in.windows) {
  $windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Sort-Object ProcessName | ForEach-Object { @{ name = $_.ProcessName; pid = $_.Id; title = [string]$_.MainWindowTitle } })
  Write-Result @{ ok = $true; windows = $windows }
  exit 0
}
if ($in.query) {
  $pattern = '*' + $in.query + '*'
  $apps = @()
  try { $apps = @(Get-StartApps | Where-Object { $_.Name -like $pattern -or $_.AppID -like $pattern } | Select-Object -First 30 | ForEach-Object { @{ name = $_.Name; appId = $_.AppID } }) } catch { }
  Write-Result @{ ok = $true; query = $in.query; startMenu = $apps; hint = 'Open one with app_open "<name>".' }
  exit 0
}
$result = @()
foreach ($app in @($in.apps)) {
  $path = Find-Exe $app
  $installed = [bool]$path
  $how = $path
  if (-not $installed) { $link = Find-Shortcut $app.start; if ($link) { $installed = $true; $how = $link } }
  if (-not $installed) { $entry = Find-StartApp $app.start; if ($entry) { $installed = $true; $how = $entry.Name } }
  $running = @(Get-Running $app.processes).Count -gt 0
  if ($installed -or $running) { $result += @{ app = $app.id; installed = $installed; running = $running; location = $how } }
}
Write-Result @{ ok = $true; apps = $result; hint = 'Applications that are not listed are not installed. app_list <keyword> searches the Start menu.' }
`;
