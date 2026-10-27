# Host tuning for three active slots (ticket 44). Four items, each chosen by its own parameter and each with an undo:
#   Wsl       %UserProfile%\.wslconfig: [wsl2] memory=<N>GB, and optionally [experimental] autoMemoryReclaim. Takes effect only at the
#             next `wsl --shutdown`, which ends every WSL session: this script never runs it. No elevation needed.
#   Sql       SQL Server's instance-wide `max server memory (MB)` (sp_configure, no restart), through the current Windows login on
#             master only. Elevated: the captain's login is sysadmin only with the full token.
#   Defender  a Windows Defender path exclusion for C:\aras_installations, and nothing else. Elevated.
#   Firewall  inbound TCP 80 only from the WSL NAT range: adds the rule arashouse-http-in-wsl and disables IIS's own
#             IIS-WebServerRole-HTTP-In-TCP. Port 80 serves every IIS site, the captain's existing installs included. Elevated.
# Without -Apply the script prints the current value of every item (`now:` lines) and the plan (`would do:` lines) and changes
# nothing. With -Apply each change is printed (`do:`) before it is made and checked after. The value an item had before its first
# apply is kept in -StateDir (state.json), and -Undo <items> puts it back. No secret is read or written. Windows PowerShell 5.1.
#
#   host-tuning.ps1                                                   inventory only
#   host-tuning.ps1 -WslMemoryGB 12 -WslAutoMemoryReclaim gradual    plan for the WSL cap (add -Apply to write .wslconfig)
#   host-tuning.ps1 -SqlMaxServerMemoryMB 4096 -DefenderExclusion -FirewallWslOnly -Apply    (elevated)
#   host-tuning.ps1 -Undo Sql,Firewall -Apply                        (elevated for Sql, Defender, Firewall)
param(
    [switch]$Apply,
    [ValidateRange(4, 28)][int]$WslMemoryGB,
    [ValidateSet('gradual', 'dropCache', 'disabled')][string]$WslAutoMemoryReclaim,
    [ValidateRange(1024, 16384)][int]$SqlMaxServerMemoryMB,
    [switch]$DefenderExclusion,
    [switch]$FirewallWslOnly,
    # The remote range the new port 80 rule allows. WSL picks its NAT subnet inside 172.16.0.0/12 at each start.
    [ValidatePattern('^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$')][string]$FirewallWslRange = '172.16.0.0/12',
    # Wsl, Sql, Defender, Firewall; a comma-separated string works too (powershell -File passes one).
    [string[]]$Undo = @(),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'arashouse\host-tuning'),
    # The WSL config file; another path only for tests.
    [string]$WslConfigPath = (Join-Path $env:USERPROFILE '.wslconfig'),
    # Print the plan only (no registry, SQL or firewall reads); the tests use it.
    [switch]$NoInventory
)
$ErrorActionPreference = 'Stop'

$ExcludedPath = 'C:\aras_installations'
$IisRule = 'IIS-WebServerRole-HTTP-In-TCP'
$OwnRule = 'arashouse-http-in-wsl'
$SqlDefaultMax = 2147483647
$WslConfig = $WslConfigPath
$StateFile = Join-Path $StateDir 'state.json'

function Fail([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine("error: $Message")
    exit $Code
}

function Step([string]$Text) {
    if ($Apply) { Write-Host "do: $Text" } else { Write-Host "would do: $Text" }
}

function Test-Elevated {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-State {
    if (Test-Path -LiteralPath $StateFile) {
        $h = @{}
        foreach ($p in (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json).PSObject.Properties) { $h[$p.Name] = $p.Value }
        return $h
    }
    return @{}
}

function Save-State($state) {
    if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
    [IO.File]::WriteAllText($StateFile, ($state | ConvertTo-Json -Depth 5), (New-Object Text.ASCIIEncoding))
}

# ---- reads ----

function Invoke-MasterQuery([string]$Sql, [hashtable]$Parameters = @{}) {
    # Shared memory, the current Windows login, master only. Returns the rows of the last result set as arrays.
    Add-Type -AssemblyName System.Data
    $conn = New-Object System.Data.SqlClient.SqlConnection('Data Source=lpc:.;Initial Catalog=master;Integrated Security=True;Connect Timeout=15;Application Name=arashouse-host-tuning')
    $conn.Open()
    try {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $Sql
        foreach ($k in $Parameters.Keys) { [void]$cmd.Parameters.AddWithValue($k, $Parameters[$k]) }
        $rows = New-Object System.Collections.ArrayList
        $r = $cmd.ExecuteReader()
        try {
            do {
                $rows.Clear()
                while ($r.Read()) { $row = New-Object object[] $r.FieldCount; [void]$r.GetValues($row); [void]$rows.Add($row) }
            } while ($r.NextResult())
        } finally { $r.Close() }
        return , @($rows)
    } finally { $conn.Close() }
}

function Get-SqlMaxMemory {
    $rows = Invoke-MasterQuery "SELECT name, CAST(value AS bigint), CAST(value_in_use AS bigint) FROM sys.configurations WHERE name IN (N'max server memory (MB)', N'show advanced options')"
    $h = @{}
    foreach ($row in $rows) { $h[[string]$row[0]] = [ordered]@{ value = [long]$row[1]; inUse = [long]$row[2] } }
    return $h
}

function Read-WslConfigValue([string]$Text, [string]$Section, [string]$Key) {
    $current = ''
    foreach ($line in ($Text -split "`r?`n")) {
        $t = $line.Trim()
        if ($t -match '^\[(.+)\]$') { $current = $Matches[1].Trim(); continue }
        if ($current -ieq $Section -and $t -match '^([^=#;]+?)\s*=\s*(.*)$' -and $Matches[1] -ieq $Key) { return $Matches[2].Trim() }
    }
    return $null
}

function Set-WslConfigValue([string]$Text, [string]$Section, [string]$Key, [string]$Value) {
    # Replaces Key in [Section], or adds it at the end of that section, or adds the section at the end. Other lines are kept.
    $lines = New-Object System.Collections.ArrayList
    if ($Text) { foreach ($l in ($Text -split "`r?`n")) { [void]$lines.Add($l) } }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -eq '') { $lines.RemoveAt($lines.Count - 1) }
    $current = ''
    $sectionEnd = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $t = $lines[$i].Trim()
        if ($t -match '^\[(.+)\]$') { $current = $Matches[1].Trim(); if ($current -ieq $Section) { $sectionEnd = $i + 1 }; continue }
        if ($current -ieq $Section) {
            if ($t -match '^([^=#;]+?)\s*=' -and $Matches[1] -ieq $Key) { $lines[$i] = "$Key=$Value"; return ($lines -join "`r`n") + "`r`n" }
            if ($t -ne '') { $sectionEnd = $i + 1 }
        }
    }
    if ($sectionEnd -ge 0) { $lines.Insert($sectionEnd, "$Key=$Value") }
    else {
        if ($lines.Count -gt 0) { [void]$lines.Add('') }
        [void]$lines.Add("[$Section]")
        [void]$lines.Add("$Key=$Value")
    }
    return ($lines -join "`r`n") + "`r`n"
}

function Test-InRange([string]$Address, [string]$Cidr) {
    $parts = $Cidr.Split('/')
    $bits = [int]$parts[1]
    $toLong = { param($ip) $b = ([Net.IPAddress]::Parse($ip)).GetAddressBytes(); [Array]::Reverse($b); [long][BitConverter]::ToUInt32($b, 0) }
    # The block size of the prefix; two addresses are in the same block when their quotients are equal.
    $size = [long][math]::Pow(2, 32 - $bits)
    return [math]::Floor((& $toLong $Address) / $size) -eq [math]::Floor((& $toLong $parts[0]) / $size)
}

function Get-WslHostAddress {
    $a = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -like 'vEthernet (WSL*' } | Select-Object -First 1
    if ($a) { return $a.IPAddress }
    return $null
}

function Get-Port80Rules {
    # Enabled inbound allow rules that open TCP port 80, by name.
    $out = New-Object System.Collections.ArrayList
    foreach ($rule in (Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue)) {
        $ports = @(($rule | Get-NetFirewallPortFilter).LocalPort)
        if ($ports -contains '80') {
            $remote = @(($rule | Get-NetFirewallAddressFilter).RemoteAddress) -join ','
            [void]$out.Add([ordered]@{ name = $rule.Name; remote = $remote })
        }
    }
    return , @($out)
}

function Get-PowerIndex([string]$Subgroup, [string]$Setting) {
    $lines = & powercfg.exe /query SCHEME_CURRENT $Subgroup $Setting 2>$null
    # A hidden setting (the lid action on some machines) is not listed: n/a.
    $r = [ordered]@{ ac = 'n/a'; dc = 'n/a' }
    foreach ($l in $lines) {
        if ($l -match 'Current (AC|DC) Power Setting Index:\s*0x([0-9a-fA-F]+)') { $r[$Matches[1].ToLower()] = [Convert]::ToInt64($Matches[2], 16) }
    }
    return $r
}

function Show-Inventory {
    $facts = [ordered]@{}
    $os = Get-CimInstance Win32_OperatingSystem
    $facts.ram = [ordered]@{
        totalMB = [int]($os.TotalVisibleMemorySize / 1024); freeMB = [int]($os.FreePhysicalMemory / 1024)
        wslVmMB = [int]((Get-Process -Name 'vmmemWSL', 'vmmem' -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
        sqlServerMB = [int]((Get-Process -Name 'sqlservr' -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
    }
    Write-Host ("now: ram: total {0} MB, free {1} MB, WSL VM {2} MB, SQL Server {3} MB" -f $facts.ram.totalMB, $facts.ram.freeMB, $facts.ram.wslVmMB, $facts.ram.sqlServerMB)

    $text = if (Test-Path -LiteralPath $WslConfig) { [IO.File]::ReadAllText($WslConfig) } else { $null }
    $facts.wsl = [ordered]@{
        configExists = [bool]($null -ne $text)
        memory = if ($text) { Read-WslConfigValue $text 'wsl2' 'memory' } else { $null }
        autoMemoryReclaim = if ($text) { Read-WslConfigValue $text 'experimental' 'autoMemoryReclaim' } else { $null }
    }
    Write-Host ("now: wsl: .wslconfig {0}, memory {1}, autoMemoryReclaim {2}" -f $(if ($facts.wsl.configExists) { 'present' } else { 'absent' }),
        $(if ($facts.wsl.memory) { $facts.wsl.memory } else { 'default (half the RAM)' }), $(if ($facts.wsl.autoMemoryReclaim) { $facts.wsl.autoMemoryReclaim } else { 'default' }))

    try {
        $m = Get-SqlMaxMemory
        $v = $m['max server memory (MB)']
        $facts.sql = [ordered]@{ maxServerMemoryMB = $v.value; maxServerMemoryInUseMB = $v.inUse }
        Write-Host ("now: sql: max server memory {0} MB (in use {1}){2}" -f $v.value, $v.inUse, $(if ($v.inUse -eq $SqlDefaultMax) { ', the default: uncapped' } else { '' }))
    } catch {
        $facts.sql = [ordered]@{ error = $_.Exception.Message }
        Write-Host "now: sql: not read ($($_.Exception.Message))"
    }

    try {
        $paths = @((Get-MpPreference -ErrorAction Stop).ExclusionPath)
        if ($paths.Count -eq 1 -and $paths[0] -like 'N/A*') { throw 'the exclusion list is readable only elevated' }
        $facts.defender = [ordered]@{ excluded = [bool]($paths | Where-Object { $_ -and $_.TrimEnd('\') -ieq $ExcludedPath }) }
        Write-Host "now: defender: $ExcludedPath excluded $($facts.defender.excluded)"
    } catch {
        $facts.defender = [ordered]@{ error = $_.Exception.Message }
        Write-Host "now: defender: not read ($($_.Exception.Message))"
    }

    $rules = Get-Port80Rules
    $facts.firewall = [ordered]@{ port80AllowRules = $rules; wslHostAddress = Get-WslHostAddress }
    Write-Host ("now: firewall: inbound TCP 80 allowed by {0}; the WSL side of the host is {1}" -f
        $(if ($rules.Count) { ($rules | ForEach-Object { "$($_.name) (remote $($_.remote))" }) -join ', ' } else { 'no enabled rule' }),
        $(if ($facts.firewall.wslHostAddress) { $facts.firewall.wslHostAddress } else { 'not found' }))

    $facts.power = [ordered]@{ standbySeconds = Get-PowerIndex 'SUB_SLEEP' 'STANDBYIDLE'; hibernateSeconds = Get-PowerIndex 'SUB_SLEEP' 'HIBERNATEIDLE'; lidAction = Get-PowerIndex 'SUB_BUTTONS' 'LIDACTION' }
    Write-Host ("now: power: sleep after AC {0} s / DC {1} s, hibernate after AC {2} s / DC {3} s, lid action AC {4} / DC {5} (0 never or do nothing; record only, not changed)" -f
        $facts.power.standbySeconds.ac, $facts.power.standbySeconds.dc, $facts.power.hibernateSeconds.ac, $facts.power.hibernateSeconds.dc, $facts.power.lidAction.ac, $facts.power.lidAction.dc)
    return $facts
}

# ---- items ----

function Invoke-Wsl($state) {
    $text = if (Test-Path -LiteralPath $WslConfig) { [IO.File]::ReadAllText($WslConfig) } else { '' }
    $new = Set-WslConfigValue $text 'wsl2' 'memory' "$($WslMemoryGB)GB"
    if ($WslAutoMemoryReclaim) { $new = Set-WslConfigValue $new 'experimental' 'autoMemoryReclaim' $WslAutoMemoryReclaim }
    $what = "memory=$($WslMemoryGB)GB" + $(if ($WslAutoMemoryReclaim) { " and autoMemoryReclaim=$WslAutoMemoryReclaim" } else { '' })
    Step "write $WslConfig with $what (other lines kept; the file before the first apply is kept in $StateDir for -Undo Wsl); it takes effect at the next 'wsl --shutdown', which this script does not run"
    if (-not $Apply) { return }
    if (-not $state.ContainsKey('wsl')) {
        $existed = Test-Path -LiteralPath $WslConfig
        if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
        if ($existed) { Copy-Item -LiteralPath $WslConfig -Destination (Join-Path $StateDir 'wslconfig.before') -Force }
        $state.wsl = [ordered]@{ existed = $existed }
    }
    [IO.File]::WriteAllText($WslConfig, $new, (New-Object Text.ASCIIEncoding))
    $state.wsl.writtenSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $WslConfig).Hash
    Save-State $state
    Write-Host "done: wsl: $WslConfig now has $what"
}

function Undo-Wsl($state) {
    if (-not $state.ContainsKey('wsl')) { Write-Host 'skip: wsl: nothing recorded to undo'; return }
    $before = Join-Path $StateDir 'wslconfig.before'
    Step $(if ($state.wsl.existed) { "restore $WslConfig from $before" } else { "delete $WslConfig (it did not exist before)" })
    if (-not $Apply) { return }
    if ((Test-Path -LiteralPath $WslConfig) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $WslConfig).Hash -ne $state.wsl.writtenSha256) {
        Fail 2 "$WslConfig changed after this script wrote it; edit it by hand (the file before the first apply is $before)."
    }
    if ($state.wsl.existed) { Copy-Item -LiteralPath $before -Destination $WslConfig -Force; Remove-Item -LiteralPath $before -Force }
    elseif (Test-Path -LiteralPath $WslConfig) { Remove-Item -LiteralPath $WslConfig -Force }
    $state.Remove('wsl')
    Save-State $state
    Write-Host 'done: wsl: undone; it takes effect at the next wsl --shutdown'
}

function Set-SqlMaxMemory([long]$Mb) {
    # show advanced options is switched on only for the change and put back as it was.
    $sql = @"
DECLARE @show int = (SELECT CAST(value AS int) FROM sys.configurations WHERE name = N'show advanced options');
IF @show = 0 BEGIN EXEC sp_configure N'show advanced options', 1; RECONFIGURE; END;
EXEC sp_configure N'max server memory (MB)', @mb; RECONFIGURE;
IF @show = 0 BEGIN EXEC sp_configure N'show advanced options', 0; RECONFIGURE; END;
SELECT CAST(value_in_use AS bigint) FROM sys.configurations WHERE name = N'max server memory (MB)';
"@
    $rows = Invoke-MasterQuery $sql @{ '@mb' = $Mb }
    return [long]$rows[0][0]
}

function Invoke-Sql($state) {
    Step "set SQL Server's max server memory to $SqlMaxServerMemoryMB MB (sp_configure on master as the current Windows login, no restart; instance-wide, so every database on the instance shares it; the value before the first apply is kept for -Undo Sql)"
    if (-not $Apply) { return }
    if (-not $state.ContainsKey('sql')) {
        $state.sql = [ordered]@{ previousMaxServerMemoryMB = (Get-SqlMaxMemory)['max server memory (MB)'].value }
        Save-State $state
    }
    $inUse = Set-SqlMaxMemory $SqlMaxServerMemoryMB
    if ($inUse -ne $SqlMaxServerMemoryMB) { Fail 1 "sql: max server memory reads $inUse MB after the change, not $SqlMaxServerMemoryMB." }
    Write-Host "done: sql: max server memory $inUse MB"
}

function Undo-Sql($state) {
    if (-not $state.ContainsKey('sql')) { Write-Host 'skip: sql: nothing recorded to undo'; return }
    $prev = [long]$state.sql.previousMaxServerMemoryMB
    Step "set SQL Server's max server memory back to $prev MB"
    if (-not $Apply) { return }
    $inUse = Set-SqlMaxMemory $prev
    if ($inUse -ne $prev) { Fail 1 "sql: max server memory reads $inUse MB after the undo, not $prev." }
    $state.Remove('sql')
    Save-State $state
    Write-Host "done: sql: max server memory $inUse MB"
}

function Test-Excluded {
    return [bool](@((Get-MpPreference).ExclusionPath) | Where-Object { $_ -and $_.TrimEnd('\') -ieq $ExcludedPath })
}

function Invoke-Defender($state) {
    Step "add the Windows Defender path exclusion $ExcludedPath (real-time and scheduled scans skip every file under it; -Undo Defender removes it if this script added it)"
    if (-not $Apply) { return }
    $already = Test-Excluded
    if (-not $state.ContainsKey('defender')) { $state.defender = [ordered]@{ addedByScript = -not $already }; Save-State $state }
    if (-not $already) { Add-MpPreference -ExclusionPath $ExcludedPath }
    if (-not (Test-Excluded)) { Fail 1 "defender: $ExcludedPath is not in the exclusion list after the change (a policy may manage Defender here)." }
    Write-Host "done: defender: $ExcludedPath excluded"
}

function Undo-Defender($state) {
    if (-not $state.ContainsKey('defender')) { Write-Host 'skip: defender: nothing recorded to undo'; return }
    if (-not $state.defender.addedByScript) { Step "leave the exclusion ${ExcludedPath}: it was there before this script"; if ($Apply) { $state.Remove('defender'); Save-State $state }; return }
    Step "remove the Windows Defender path exclusion $ExcludedPath"
    if (-not $Apply) { return }
    Remove-MpPreference -ExclusionPath $ExcludedPath
    if (Test-Excluded) { Fail 1 "defender: $ExcludedPath is still excluded after the undo." }
    $state.Remove('defender')
    Save-State $state
    Write-Host "done: defender: $ExcludedPath no longer excluded"
}

function Invoke-Firewall($state) {
    Step "add the inbound rule $OwnRule (allow TCP 80 from $FirewallWslRange, every profile), then disable $IisRule (allow TCP 80 from any address); afterwards no other machine reaches any IIS site on port 80, the captain's own installs included; -Undo Firewall reverses both"
    if (-not $Apply) { return }
    $wsl = Get-WslHostAddress
    if (-not $wsl) { Fail 2 'firewall: no vEthernet (WSL) address found; start WSL first, so the range can be checked.' }
    if (-not (Test-InRange $wsl $FirewallWslRange)) { Fail 2 "firewall: the WSL side of the host is $wsl, outside $FirewallWslRange; pass -FirewallWslRange." }
    $iis = Get-NetFirewallRule -Name $IisRule -ErrorAction SilentlyContinue
    if (-not $state.ContainsKey('firewall')) {
        $state.firewall = [ordered]@{ iisRuleWasEnabled = [bool]($iis -and $iis.Enabled -eq 'True'); range = $FirewallWslRange }
        Save-State $state
    }
    if (Get-NetFirewallRule -Name $OwnRule -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name $OwnRule }
    New-NetFirewallRule -Name $OwnRule -DisplayName 'arashouse: HTTP in from WSL only' -Description 'Ticket 44: port 80 from the WSL NAT range only. Remove with host-tuning.ps1 -Undo Firewall.' `
        -Direction Inbound -Protocol TCP -LocalPort 80 -RemoteAddress $FirewallWslRange -Action Allow -Profile Any | Out-Null
    if ($iis) { Disable-NetFirewallRule -Name $IisRule }
    $left = @(Get-Port80Rules | Where-Object { $_.name -ne $OwnRule })
    if ($left.Count) { Write-Host ("warn: firewall: port 80 is still open by {0}; this script does not touch other rules" -f (($left | ForEach-Object { $_.name }) -join ', ')) }
    Write-Host "done: firewall: inbound TCP 80 from $FirewallWslRange only (by $OwnRule)"
}

function Undo-Firewall($state) {
    if (-not $state.ContainsKey('firewall')) { Write-Host 'skip: firewall: nothing recorded to undo'; return }
    Step ("remove the rule $OwnRule" + $(if ($state.firewall.iisRuleWasEnabled) { " and enable $IisRule again" } else { '' }))
    if (-not $Apply) { return }
    if ($state.firewall.iisRuleWasEnabled) { Enable-NetFirewallRule -Name $IisRule }
    if (Get-NetFirewallRule -Name $OwnRule -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name $OwnRule }
    $state.Remove('firewall')
    Save-State $state
    Write-Host 'done: firewall: port 80 rules as before'
}

# ---- main ----

# PowerShell names are case-insensitive, so the chosen items are $chosen ($apply would be -Apply).
$chosen = @()
if ($PSBoundParameters.ContainsKey('WslMemoryGB')) { $chosen += 'Wsl' }
elseif ($WslAutoMemoryReclaim) { Fail 2 '-WslAutoMemoryReclaim goes with -WslMemoryGB.' }
if ($PSBoundParameters.ContainsKey('SqlMaxServerMemoryMB')) { $chosen += 'Sql' }
if ($DefenderExclusion) { $chosen += 'Defender' }
if ($FirewallWslOnly) { $chosen += 'Firewall' }
$items = @('Wsl', 'Sql', 'Defender', 'Firewall')
$Undo = @($Undo | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($item in $Undo) {
    $known = $items | Where-Object { $_ -ieq $item }
    if (-not $known) { Fail 2 "-Undo takes $($items -join ', '); '$item' is not one of them." }
}
$Undo = @($items | Where-Object { $Undo -contains $_ })
foreach ($item in $Undo) { if ($chosen -contains $item) { Fail 2 "$item is both applied and undone; choose one." } }
if ($PSBoundParameters.ContainsKey('FirewallWslRange') -and -not $FirewallWslOnly) { Fail 2 '-FirewallWslRange goes with -FirewallWslOnly.' }
$elevatedItems = @($chosen + $Undo | Where-Object { $_ -ne 'Wsl' })
if ($Apply -and $elevatedItems.Count -and -not (Test-Elevated)) {
    Fail 4 ("-Apply for {0} needs an elevated PowerShell (Run as administrator)." -f ($elevatedItems -join ', '))
}

if ($Apply) { Write-Host 'apply: host tuning (every change is printed before it is made)' }
else { Write-Host 'dry run: host tuning changes nothing; pass -Apply to make changes' }
$result = [ordered]@{ startedUtc = [DateTime]::UtcNow.ToString('o'); apply = [bool]$Apply; items = $chosen; undo = $Undo }
if (-not $NoInventory) { $result.before = Show-Inventory }
if (-not $chosen.Count -and -not $Undo.Count) { Write-Host 'dry run: no item chosen: -WslMemoryGB, -SqlMaxServerMemoryMB, -DefenderExclusion, -FirewallWslOnly, or -Undo <items>' }

$state = Read-State
try {
    foreach ($item in $chosen) { & "Invoke-$item" $state }
    foreach ($item in $Undo) { & "Undo-$item" $state }
} catch {
    Fail 1 $_.Exception.Message
}

if ($Apply -and ($chosen.Count -or $Undo.Count)) {
    if (-not $NoInventory) { $result.after = Show-Inventory }
    $outDir = Join-Path $StateDir 'out'
    if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
    $file = Join-Path $outDir ('host-tuning-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.json')
    [IO.File]::WriteAllText($file, ($result | ConvertTo-Json -Depth 6), (New-Object Text.ASCIIEncoding))
    Write-Host "wrote $file"
}
exit 0
