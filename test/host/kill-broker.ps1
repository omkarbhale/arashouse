# Ticket 38's reboot-like failure (docs/capacity.md): run elevated, while test/host/capacity.ts runs from WSL. It waits
# for the worker's request files in -TriggerDir (kill-1.request, kill-2.request, ...), and for each one ends the
# ArasHouseBroker service's process tree at once (taskkill /T /F: the service wrapper, its node.exe and any step the
# broker was running), as a crash or a power cut would. Then it waits for the service's restart recovery (5 s, 10 s,
# 60 s; docs/setup.md) to bring it back, and starts the service itself only if recovery has not done so in 120 s.
# It writes kill-<n>.done when the tree is ended and kill-<n>.back when the service runs again, and logs each step to
# kill-broker.log, all in -TriggerDir. It reads only whether a request file exists, never its content.
#
# What it touches, and nothing else: the process tree of the service named ArasHouseBroker, that service's start (only
# if recovery did not restart it), and files in -TriggerDir. No other service, process, file, IIS object or database.
#
# Exit codes: 0 every kill done and the service back; 1 the service has no process, or did not come back; 2 refused
# arguments; 3 timed out waiting for a request; 4 not elevated.
param(
  [Parameter(Mandatory = $true)][string]$TriggerDir,
  [ValidateRange(1, 4)][int]$Kills = 2,
  [ValidateRange(1, 240)][int]$TimeoutMinutes = 120
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'ArasHouseBroker'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'refused: run this elevated'
  exit 4
}
if (-not (Test-Path -LiteralPath $TriggerDir -PathType Container)) {
  Write-Output "refused: no folder $TriggerDir"
  exit 2
}
$LogFile = Join-Path $TriggerDir 'kill-broker.log'

function Write-Step([string]$Text) {
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), $Text
  Write-Output $line
  Add-Content -LiteralPath $LogFile -Value $line -Encoding ASCII
}

function Write-Mark([string]$Name, [string]$Text) {
  Set-Content -LiteralPath (Join-Path $TriggerDir $Name) -Value $Text -Encoding ASCII
}

function Get-Broker {
  $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($null -eq $service) { throw "there is no service $ServiceName" }
  return $service
}

# The process and its descendants, by parent id, from one snapshot; the root first.
function Get-Tree([int]$RootId) {
  $all = @(Get-CimInstance Win32_Process)
  $tree = New-Object System.Collections.ArrayList
  $root = $all | Where-Object { $_.ProcessId -eq $RootId }
  if ($null -eq $root) { return @() }
  [void]$tree.Add($root)
  for ($i = 0; $i -lt $tree.Count; $i++) {
    $parent = $tree[$i]
    foreach ($child in $all) {
      if ($child.ParentProcessId -eq $parent.ProcessId -and $child.ProcessId -ne $parent.ProcessId) { [void]$tree.Add($child) }
    }
  }
  return $tree.ToArray()
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
Write-Step "waiting for $Kills request(s) in $TriggerDir until $($deadline.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"

for ($n = 1; $n -le $Kills; $n++) {
  $request = Join-Path $TriggerDir "kill-$n.request"
  while (-not (Test-Path -LiteralPath $request -PathType Leaf)) {
    if ((Get-Date) -gt $deadline) {
      Write-Step "timed out waiting for kill-$n.request"
      exit 3
    }
    Start-Sleep -Milliseconds 250
  }

  $before = Get-Broker
  $old = [int]$before.ProcessId
  if ($before.State -ne 'Running' -or $old -le 0) {
    Write-Step "kill ${n}: $ServiceName is $($before.State) with no process; nothing ended"
    Write-Mark "kill-$n.done" "failed: no process"
    exit 1
  }
  $tree = @(Get-Tree $old)
  $names = ($tree | ForEach-Object { '{0} {1}' -f $_.Name, $_.ProcessId }) -join ', '
  $killedAt = Get-Date
  & taskkill.exe /PID $old /T /F | Out-Null
  $code = $LASTEXITCODE
  Write-Step "kill ${n}: taskkill /T /F of $ServiceName pid $old exited $code; the tree was: $names"
  Write-Mark "kill-$n.done" ("pid {0}; taskkill exit {1}; tree {2}" -f $old, $code, $names)

  $back = $null
  while (((Get-Date) - $killedAt).TotalSeconds -lt 120) {
    Start-Sleep -Milliseconds 500
    $now = Get-Broker
    if ($now.State -eq 'Running' -and [int]$now.ProcessId -gt 0 -and [int]$now.ProcessId -ne $old) { $back = $now; break }
  }
  $how = 'its restart recovery'
  if ($null -eq $back) {
    Write-Step "kill ${n}: $ServiceName not running again after 120 s; starting it"
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 5
    $now = Get-Broker
    if ($now.State -eq 'Running' -and [int]$now.ProcessId -gt 0) { $back = $now; $how = 'Start-Service' }
  }
  if ($null -eq $back) {
    Write-Step "kill ${n}: $ServiceName did not come back"
    Write-Mark "kill-$n.back" 'failed: not running'
    exit 1
  }
  $seconds = [math]::Round(((Get-Date) - $killedAt).TotalSeconds, 1)
  Write-Step "kill ${n}: $ServiceName running again as pid $($back.ProcessId), $seconds s after the kill, by $how"
  Write-Mark "kill-$n.back" ("pid {0}; {1} s; {2}" -f $back.ProcessId, $seconds, $how)
}

Write-Step "done: $Kills kill(s)"
exit 0
