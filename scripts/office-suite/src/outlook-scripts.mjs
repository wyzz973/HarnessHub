// Windows PowerShell 5.1 sources of the Outlook tools (classic Outlook COM automation).
// COM activation starts OUTLOOK.EXE through DCOM, i.e. outside the agent's Job object.

export const CONNECT = String.raw`
$outlook = $null
try { $outlook = New-Object -ComObject Outlook.Application } catch { }
if ($null -eq $outlook) {
  Fail 'OUTLOOK_UNAVAILABLE' 'Classic Outlook (COM automation) is not installed or could not start on this computer.' 'Write the message with eml_create or the event with ics_create and open that file with app_open; the new Outlook (olk.exe) cannot be automated.'
}
$namespace = $outlook.GetNamespace('MAPI')
try { $namespace.Logon($null, $null, $false, $false) } catch { }
function Read-Text($path) { if ($path) { return [IO.File]::ReadAllText($path) } return '' }
`;

export const MAIL = String.raw`
$mail = $outlook.CreateItem(0)
foreach ($address in @($in.to | Where-Object { $_ })) { $recipient = $mail.Recipients.Add($address); $recipient.Type = 1 }
foreach ($address in @($in.cc | Where-Object { $_ })) { $recipient = $mail.Recipients.Add($address); $recipient.Type = 2 }
foreach ($address in @($in.bcc | Where-Object { $_ })) { $recipient = $mail.Recipients.Add($address); $recipient.Type = 3 }
$mail.Subject = [string]$in.subject
if ($in.htmlFile) { $mail.HTMLBody = Read-Text $in.htmlFile } else { $mail.Body = Read-Text $in.textFile }
$attached = 0
foreach ($file in @($in.attachments | Where-Object { $_ })) { [void]$mail.Attachments.Add($file); $attached++ }
$resolved = $true
try { $resolved = $mail.Recipients.ResolveAll() } catch { }
$unresolved = @()
if (-not $resolved) { foreach ($recipient in $mail.Recipients) { if (-not $recipient.Resolved) { $unresolved += [string]$recipient.Name } } }
$state = $in.mode
$note = $null
if ($in.mode -eq 'send') {
  if (-not $resolved) {
    $mail.Save(); $state = 'draft'
    $note = 'These recipients are not valid addresses or contacts: ' + ($unresolved -join ', ') + '. The message was saved to Drafts instead of being sent.'
  } else {
    try { $mail.Send(); $state = 'sent' }
    catch { $mail.Save(); $state = 'draft'; $note = 'Outlook refused to send (' + $_.Exception.Message + '); the message was saved to Drafts.' }
  }
} elseif ($in.mode -eq 'draft') { $mail.Save() }
else { $mail.Display($false); $state = 'displayed' }
Write-Result @{ ok = $true; state = $state; subject = [string]$in.subject; recipients = (@($in.to).Count + @($in.cc | Where-Object { $_ }).Count + @($in.bcc | Where-Object { $_ }).Count); attachments = $attached; note = $note }
`;

export const EVENT = String.raw`
$item = $outlook.CreateItem(1)
$item.Subject = [string]$in.subject
$item.Start = [datetime]::ParseExact($in.start, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
if ($in.allDay) { $item.AllDayEvent = $true }
if ($in.end) { $item.End = [datetime]::ParseExact($in.end, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture) }
elseif (-not $in.allDay) { $item.Duration = [int]$in.duration }
if ($in.location) { $item.Location = [string]$in.location }
if ($in.textFile) { $item.Body = Read-Text $in.textFile }
if ($null -ne $in.reminder) { $item.ReminderSet = $true; $item.ReminderMinutesBeforeStart = [int]$in.reminder } else { $item.ReminderSet = $false }
$attendees = @($in.attendees | Where-Object { $_ })
$state = 'saved'
$note = $null
if ($attendees.Count -gt 0) {
  $item.MeetingStatus = 1
  foreach ($address in $attendees) { [void]$item.Recipients.Add($address) }
  $resolved = $true
  try { $resolved = $item.Recipients.ResolveAll() } catch { }
  if ($in.mode -eq 'send' -and $resolved) {
    try { $item.Send(); $state = 'sent' } catch { $item.Save(); $note = 'Outlook refused to send the invitation (' + $_.Exception.Message + '); the meeting was saved to the calendar.' }
  } else {
    $item.Save()
    if ($in.mode -eq 'send') { $note = 'Some attendees are not valid addresses or contacts; the meeting was saved without sending invitations.' }
  }
} else { $item.Save() }
if ($in.mode -eq 'display') { $item.Display($false); $state = 'displayed' }
Write-Result @{ ok = $true; state = $state; subject = [string]$in.subject; start = $in.start; attendees = $attendees.Count; note = $note }
`;

export const READ = String.raw`
$folders = @{ inbox = 6; sent = 5; drafts = 16; outbox = 4; deleted = 3; calendar = 9; contacts = 10; tasks = 13 }
$folder = $namespace.GetDefaultFolder($folders[[string]$in.folder])
$items = $folder.Items
$top = [int]$in.top
$result = @()
if ($in.folder -eq 'calendar') {
  $items.Sort('[Start]')
  $items.IncludeRecurrences = $true
  $from = [datetime]::Today
  if ($in.since) { $from = [datetime]::ParseExact($in.since, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
  $to = $from.AddDays([int]$in.days)
  $found = $items.Restrict("[Start] >= '" + $from.ToString('g') + "' AND [Start] <= '" + $to.ToString('g') + "'")
  foreach ($item in $found) {
    $result += @{ subject = [string]$item.Subject; start = $item.Start.ToString('yyyy-MM-dd HH:mm'); end = $item.End.ToString('yyyy-MM-dd HH:mm'); location = [string]$item.Location; allDay = [bool]$item.AllDayEvent; meeting = ($item.MeetingStatus -ne 0) }
    if ($result.Count -ge $top) { break }
  }
} elseif ($in.folder -eq 'contacts') {
  foreach ($item in $items) {
    if ($item.Class -ne 40) { continue }
    if ($in.search -and ([string]$item.FullName -notlike ('*' + $in.search + '*'))) { continue }
    $result += @{ name = [string]$item.FullName; email = [string]$item.Email1Address; company = [string]$item.CompanyName; mobile = [string]$item.MobileTelephoneNumber }
    if ($result.Count -ge $top) { break }
  }
} elseif ($in.folder -eq 'tasks') {
  foreach ($item in $items) {
    if ($item.Class -ne 48) { continue }
    $due = $null
    if ($item.DueDate -and $item.DueDate.Year -lt 4000) { $due = $item.DueDate.ToString('yyyy-MM-dd') }
    $result += @{ subject = [string]$item.Subject; due = $due; complete = [bool]$item.Complete }
    if ($result.Count -ge $top) { break }
  }
} else {
  $order = '[ReceivedTime]'
  if ($in.folder -eq 'sent') { $order = '[SentOn]' }
  if ($in.folder -eq 'drafts' -or $in.folder -eq 'outbox') { $order = '[LastModificationTime]' }
  if ($in.unread) { $items = $items.Restrict('[UnRead] = true') }
  if ($in.search) { $items = $items.Restrict('@SQL="urn:schemas:httpmail:subject" like ''%' + ([string]$in.search).Replace("'", "''") + '%''') }
  $items.Sort($order, $true)
  foreach ($item in $items) {
    if ($item.Class -ne 43) { continue }
    $when = $null
    try { if ($in.folder -eq 'sent') { $when = $item.SentOn.ToString('yyyy-MM-dd HH:mm') } else { $when = $item.ReceivedTime.ToString('yyyy-MM-dd HH:mm') } } catch { }
    $entry = @{ subject = [string]$item.Subject; from = [string]$item.SenderName; to = [string]$item.To; time = $when; unread = [bool]$item.UnRead; attachments = $item.Attachments.Count }
    if ($in.withBody) { $body = [string]$item.Body; if ($body.Length -gt 800) { $body = $body.Substring(0, 800) }; $entry.body = $body }
    $result += $entry
    if ($result.Count -ge $top) { break }
  }
}
Write-Result @{ ok = $true; folder = [string]$in.folder; count = $result.Count; items = $result }
`;
