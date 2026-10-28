# audit-secrets.ps1 (ticket 50, docs/audit.md, check 4): is a secret anywhere it should not be? Run elevated (firstmate's
# gate), because the broker's logs, its secrets and other users' process command lines are Administrators-only.
#
# Started without -Monitor, it starts itself again with -Monitor as a hidden process (elevated like its parent), waits until
# that process is watching, prints where the result will be and exits 0: the gate's call returns in seconds.
# The monitor then records the command line of every process that starts (a WMI creation event, polled every 0.2 s, and a
# full process list every 2 s), until the worker, not elevated, takes a lease with `arashouse get ... --password-fd` and
# seals that lease's password in staging\audit-50\lease.dpapi (ConvertFrom-SecureString: only this Windows user can decrypt
# it), with the slot's id (not a secret) in lease-slot.txt. It then decrypts, in this process only:
#   - the lease's password, and its MD5 hex (what an Aras client sends in its place);
#   - the stored licences' lic_key and act_key (secrets\licence-12.bin and licence-14.bin, machine-scope DPAPI), when
#     this process may read them;
#   - the broker's client token (broker\client.token);
# and counts each (and inside any -EncodedCommand payload) in: the recorded command lines; every file under logs\, staging\ (but the sealed file) and broker\ (but
# its app\ and the token file); the text files of golden\, golden-build\ and the leased slot's tree (where the licence is
# expected in InnovatorServerConfig.xml only); Windows Installer logs (MSI*.log in C:\Windows\Temp and every user's temp);
# PowerShell console histories and transcripts; arashouse's WSL-side state (~/.arashouse, through \\wsl.localhost); and the
# Application, System, Windows PowerShell, PowerShell Operational and Security (4688) event logs.
# The result, staging\audit-50\secrets-result.txt, holds only places, counts and the paths of files with a hit: never a
# secret, an MD5 or a token. The sealed file is deleted at the end. Nothing else is changed.
#
#   audit-secrets.ps1                 # elevated; returns at once
#   audit-secrets.ps1 -Minutes 45     # how long the monitor waits for lease.dpapi (default 30)
#
# Exit: 0 the monitor is watching (or, as the monitor, it finished); 1 the monitor did not start; 2 a precondition;
# 4 not elevated.
param(
    [ValidateRange(5, 120)][int]$Minutes = 30,
    [switch]$Monitor
)
$ErrorActionPreference = 'Stop'
$Root = 'C:\aras_installations'
$Dir = Join-Path $Root 'staging\audit-50'
$Sealed = Join-Path $Dir 'lease.dpapi'
$SlotFile = Join-Path $Dir 'lease-slot.txt'
$Ready = Join-Path $Dir 'monitor-ready.txt'
$Result = Join-Path $Dir 'secrets-result.txt'
$Distro = 'Ubuntu'
$WslState = "\\wsl.localhost\$Distro\home\omkarb\.arashouse"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { [Console]::Error.WriteLine('error: run it elevated'); exit 4 }
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { [Console]::Error.WriteLine("error: $Root does not exist"); exit 2 }

if (-not $Monitor) {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    foreach ($f in @($Ready, $Result, $Sealed, $SlotFile)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
    $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-Monitor', '-Minutes', [string]$Minutes)
    for ($i = 0; $i -lt 120; $i++) {
        if (Test-Path -LiteralPath $Ready) { [Console]::Out.WriteLine("monitor pid $($p.Id) is watching for $Minutes minutes; result: $Result"); exit 0 }
        if ($p.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    [Console]::Error.WriteLine('error: the monitor did not start')
    exit 1
}

# ---- the monitor: record command lines until the lease's password is sealed ----------------------------------------------
$started = Get-Date
$commandLines = New-Object 'System.Collections.Generic.HashSet[string]'
$seenPids = New-Object 'System.Collections.Generic.HashSet[int]'
$query = "SELECT * FROM __InstanceCreationEvent WITHIN 0.2 WHERE TargetInstance ISA 'Win32_Process'"
Register-CimIndicationEvent -Query $query -SourceIdentifier 'arashouse-audit-50' | Out-Null
function Add-Snapshot {
    foreach ($proc in @(Get-CimInstance -ClassName Win32_Process)) {
        [void]$seenPids.Add([int]$proc.ProcessId)
        if ($proc.CommandLine) { [void]$commandLines.Add([string]$proc.CommandLine) }
    }
}
function Drain-Events {
    foreach ($e in @(Get-Event -SourceIdentifier 'arashouse-audit-50' -ErrorAction SilentlyContinue)) {
        $t = $e.SourceEventArgs.NewEvent.TargetInstance
        [void]$seenPids.Add([int]$t.ProcessId)
        if ($t.CommandLine) { [void]$commandLines.Add([string]$t.CommandLine) }
        Remove-Event -EventIdentifier $e.EventIdentifier
    }
}
Add-Snapshot
Set-Content -LiteralPath $Ready -Value ("watching since {0:o}" -f $started) -Encoding ASCII
$deadline = $started.AddMinutes($Minutes)
$lastSnapshot = Get-Date
$timedOut = $true
while ((Get-Date) -lt $deadline) {
    Wait-Event -SourceIdentifier 'arashouse-audit-50' -Timeout 1 | Out-Null
    Drain-Events
    if (((Get-Date) - $lastSnapshot).TotalSeconds -ge 2) { Add-Snapshot; $lastSnapshot = Get-Date }
    if (Test-Path -LiteralPath $Sealed) { Start-Sleep -Seconds 3; Drain-Events; Add-Snapshot; $timedOut = $false; break }
}
Unregister-Event -SourceIdentifier 'arashouse-audit-50' -ErrorAction SilentlyContinue
$out = New-Object 'System.Collections.Generic.List[string]'
$out.Add("monitor: started $($started.ToString('o')), $([math]::Round(((Get-Date) - $started).TotalSeconds)) s, $($seenPids.Count) processes seen, $($commandLines.Count) distinct command lines")
if ($timedOut) {
    $out.Add("monitor: no $Sealed within $Minutes minutes; nothing was searched")
    Set-Content -LiteralPath $Result -Value $out -Encoding ASCII
    exit 0
}

# ---- the needles, in this process only ---------------------------------------------------------------------------------
$needles = New-Object 'System.Collections.Generic.List[object]'
function Add-Needle([string]$Kind, [string]$Value) { if ($Value -and $Value.Length -ge 8) { $needles.Add(@{ kind = $Kind; value = $Value }) } }
function Get-Md5Hex([string]$Text) {
    $b = [Text.Encoding]::UTF8.GetBytes($Text)
    try { return -join ([Security.Cryptography.MD5]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) } finally { [Array]::Clear($b, 0, $b.Length) }
}
$leaseCount = 0
foreach ($line in @(Get-Content -LiteralPath $Sealed | Where-Object { $_.Trim() })) {
    $secure = ConvertTo-SecureString -String $line.Trim()
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $secure.Dispose() }
    Add-Needle 'lease password' $plain
    $md5 = Get-Md5Hex $plain
    Add-Needle 'lease password md5' $md5
    Add-Needle 'lease password md5' $md5.ToUpperInvariant()
    $plain = $null; $md5 = $null; $leaseCount++
}
$out.Add("needles: $leaseCount lease password(s), with their MD5")
Add-Type -AssemblyName System.Security
foreach ($line in @('12', '14')) {
    $f = Join-Path $Root "secrets\licence-$line.bin"
    try {
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($f), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
        $text = [Text.Encoding]::UTF8.GetString($bytes); [Array]::Clear($bytes, 0, $bytes.Length)
        $values = @()
        try { $o = $text | ConvertFrom-Json; foreach ($k in @('lic_key', 'act_key')) { if ($o.$k) { $values += [string]$o.$k } } } catch { $values = @($text) }
        foreach ($v in $values) { Add-Needle 'licence' $v }
        $out.Add("needles: licence line $line, $($values.Count) value(s)")
        $text = $null; $values = $null; $o = $null
    } catch {
        $why = $_.Exception; while ($why.InnerException) { $why = $why.InnerException }
        $out.Add("needles: licence line ${line}: not read ($($why.GetType().Name)); not searched")
    }
}
try {
    Add-Needle 'broker token' ((Get-Content -LiteralPath (Join-Path $Root 'broker\client.token') -Raw).Trim())
    $out.Add('needles: the broker token')
} catch { $out.Add("needles: the broker token: not read ($($_.Exception.GetType().Name))") }
$kinds = @('lease password', 'lease password md5', 'licence', 'broker token')

# ---- the search --------------------------------------------------------------------------------------------------------
$TextExt = @('.log', '.txt', '.json', '.xml', '.config', '.ini', '.csv', '.ps1', '.psm1', '.md', '.tsv', '.msg', '.jsonl', '')
$MaxBytes = 32MB
function Search-Text([string]$Text) {
    $hits = @{}
    # A powershell -EncodedCommand argument is base64 of UTF-16LE text: it is searched decoded as well.
    foreach ($m in [regex]::Matches($Text, '(?i)-(?:e|ec|en|enc|encodedcommand)\s+([A-Za-z0-9+/]{16,}={0,2})')) {
        try { $Text += "`n" + [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($m.Groups[1].Value)) } catch { }
    }
    foreach ($n in $needles) {
        $c = 0; $i = $Text.IndexOf($n.value, [StringComparison]::Ordinal)
        while ($i -ge 0) { $c++; $i = $Text.IndexOf($n.value, $i + 1, [StringComparison]::Ordinal) }
        if ($c -gt 0) { $hits[$n.kind] = $(if ($hits.ContainsKey($n.kind)) { $hits[$n.kind] } else { 0 }) + $c }
    }
    return $hits
}
function Search-Place([string]$Place, [object[]]$Files) {
    $totals = @{}; foreach ($k in $kinds) { $totals[$k] = 0 }
    $where = New-Object 'System.Collections.Generic.List[string]'
    $n = 0; $skipped = 0
    foreach ($f in $Files) {
        if ($f.Length -gt $MaxBytes) { $skipped++; continue }
        try { $bytes = [IO.File]::ReadAllBytes($f.FullName) } catch { $skipped++; continue }
        $n++
        $hits = Search-Text ([Text.Encoding]::UTF8.GetString($bytes))
        $wide = Search-Text ([Text.Encoding]::Unicode.GetString($bytes))
        foreach ($k in $wide.Keys) { $hits[$k] = $(if ($hits.ContainsKey($k)) { $hits[$k] } else { 0 }) + $wide[$k] }
        if ($hits.Count -gt 0) {
            foreach ($k in $hits.Keys) { $totals[$k] += $hits[$k] }
            if ($where.Count -lt 20) { $where.Add("    $($f.FullName): " + (($hits.Keys | Sort-Object | ForEach-Object { "$_=$($hits[$_])" }) -join ' ')) }
        }
    }
    $out.Add("${Place}: files=$n skipped=$skipped " + (($kinds | ForEach-Object { "{0}={1}" -f ($_ -replace ' ', '-'), $totals[$_] }) -join ' '))
    foreach ($w in $where) { $out.Add($w) }
}
function Files-Under([string]$Path, [switch]$TextOnly, [string[]]$ExcludeDirs = @(), [string[]]$ExcludeFiles = @()) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
        $full = $_.FullName
        (-not $TextOnly -or $TextExt -contains $_.Extension.ToLowerInvariant()) -and
        -not ($ExcludeDirs | Where-Object { $full.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase) }) -and
        -not ($ExcludeFiles | Where-Object { $full -ieq $_ })
    })
}

# The command lines.
$cl = @{}; foreach ($k in $kinds) { $cl[$k] = 0 }
foreach ($line in $commandLines) { $h = Search-Text $line; foreach ($k in $h.Keys) { $cl[$k] += $h[$k] } }
$out.Add('command lines: ' + (($kinds | ForEach-Object { "{0}={1}" -f ($_ -replace ' ', '-'), $cl[$_] }) -join ' '))
$commandLines.Clear()

Search-Place 'logs' (Files-Under (Join-Path $Root 'logs'))
Search-Place 'staging' (Files-Under (Join-Path $Root 'staging') -ExcludeFiles @($Sealed, $Result, $Ready))
Search-Place 'broker' (Files-Under (Join-Path $Root 'broker') -ExcludeDirs @((Join-Path $Root 'broker\app')) -ExcludeFiles @((Join-Path $Root 'broker\client.token')))
Search-Place 'golden (text files)' (Files-Under (Join-Path $Root 'golden') -TextOnly)
Search-Place 'golden-build (text files)' (Files-Under (Join-Path $Root 'golden-build') -TextOnly)
$slot = if (Test-Path -LiteralPath $SlotFile) { (Get-Content -LiteralPath $SlotFile -Raw).Trim() } else { '' }
if ($slot -match '^(12sp9|23|35)-(\d{2})$') {
    $slotDir = Join-Path $Root "slots\$($Matches[1])\$($Matches[2])"
    $configs = @(Files-Under $slotDir -TextOnly | Where-Object { $_.Name -ieq 'InnovatorServerConfig.xml' })
    Search-Place "slot $slot InnovatorServerConfig.xml (the licence is expected here)" $configs
    Search-Place "slot $slot, every other text file" @(Files-Under $slotDir -TextOnly | Where-Object { $_.Name -ine 'InnovatorServerConfig.xml' })
} else { $out.Add("slot: lease-slot.txt names no slot; the slot's tree was not searched") }
$msiLogs = @(Get-ChildItem -Path 'C:\Windows\Temp\MSI*.log' -File -Force -ErrorAction SilentlyContinue) + @(Get-ChildItem -Path 'C:\Users\*\AppData\Local\Temp\MSI*.log' -File -Force -ErrorAction SilentlyContinue)
Search-Place 'msi logs' $msiLogs
Search-Place 'powershell histories' @(Get-ChildItem -Path 'C:\Users\*\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\*.txt' -File -Force -ErrorAction SilentlyContinue)
Search-Place 'powershell transcripts' @(Get-ChildItem -Path 'C:\Users\*\Documents' -Recurse -Filter 'PowerShell_transcript*.txt' -File -Force -ErrorAction SilentlyContinue)
if (Test-Path -LiteralPath $WslState) { Search-Place 'wsl ~/.arashouse' (Files-Under $WslState) } else { $out.Add("wsl ~/.arashouse: $WslState not reachable from this process; the worker searches it") }

foreach ($log in @('Application', 'System', 'Windows PowerShell', 'Microsoft-Windows-PowerShell/Operational')) {
    $t = @{}; foreach ($k in $kinds) { $t[$k] = 0 }
    $count = 0
    try {
        foreach ($ev in @(Get-WinEvent -LogName $log -MaxEvents 30000 -ErrorAction Stop)) {
            $count++
            $h = Search-Text $ev.ToXml(); foreach ($k in $h.Keys) { $t[$k] += $h[$k] }
        }
        $out.Add("event log ${log}: events=$count " + (($kinds | ForEach-Object { "{0}={1}" -f ($_ -replace ' ', '-'), $t[$_] }) -join ' '))
    } catch { $out.Add("event log ${log}: not read ($($_.Exception.Message))") }
}
try {
    $sec = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4688; StartTime = $started.AddDays(-30) } -MaxEvents 30000 -ErrorAction Stop)
    $t = @{}; foreach ($k in $kinds) { $t[$k] = 0 }
    foreach ($ev in $sec) { $h = Search-Text $ev.ToXml(); foreach ($k in $h.Keys) { $t[$k] += $h[$k] } }
    $out.Add("event log Security 4688: events=$($sec.Count) " + (($kinds | ForEach-Object { "{0}={1}" -f ($_ -replace ' ', '-'), $t[$_] }) -join ' '))
} catch { $out.Add("event log Security 4688: none recorded ($($_.Exception.Message))") }

$needles.Clear()
Remove-Item -LiteralPath $Sealed -Force -ErrorAction SilentlyContinue
$out.Add("sealed file deleted: $(-not (Test-Path -LiteralPath $Sealed))")
$out.Add("monitor: finished $((Get-Date).ToString('o'))")
Set-Content -LiteralPath $Result -Value $out -Encoding ASCII
exit 0
