# audit-probe.ps1 (ticket 50, docs/audit.md): the read-only half of the host audit, run by the worker, not elevated.
# Prints one "<check>: <value>" line per observation. It reads ACLs, listeners, firewall rules and policy keys, and sends
# the broker four requests that must be refused before any verb runs (no token, a wrong token, a line past the size limit,
# a line that is not JSON); the broker audits each as unauthorised or malformed. It never reads the token and changes
# nothing. Plain ASCII, Windows PowerShell 5.1.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File audit-probe.ps1
#
# Exit: 0 when it ran (the lines are the result); 2 when the root does not exist.
$ErrorActionPreference = 'Stop'
$Root = 'C:\aras_installations'
$PipeName = 'arashouse-broker'
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { [Console]::Error.WriteLine("error: $Root does not exist"); exit 2 }

function Say([string]$Check, [string]$Value) { [Console]::Out.WriteLine("${Check}: $Value") }

# ---- the pipe -----------------------------------------------------------------------------------------------------------
try {
    $c = New-Object IO.Pipes.NamedPipeClientStream('.', $PipeName, [IO.Pipes.PipeDirection]::In)
    $c.Connect(3000)
    Say 'pipe dacl' $c.GetAccessControl().GetSecurityDescriptorSddlForm('Access')
    $c.Dispose()
} catch { Say 'pipe dacl' "unreadable: $($_.Exception.Message)" }

function Send-Line([string]$Line) {
    $c = New-Object IO.Pipes.NamedPipeClientStream('.', $PipeName, [IO.Pipes.PipeDirection]::InOut)
    try {
        $c.Connect(3000)
        $bytes = [Text.Encoding]::UTF8.GetBytes($Line)
        try { $c.Write($bytes, 0, $bytes.Length); $c.Flush() } catch { }
        $reader = New-Object IO.StreamReader($c, [Text.Encoding]::UTF8)
        $answer = $reader.ReadLine()
        if ($null -eq $answer) { return '(no answer)' }
        return $answer
    } catch {
        return "(failed: $($_.Exception.Message))"
    } finally { $c.Dispose() }
}

Say 'pipe without a token' (Send-Line ('{"v":1,"request":{"id":"audit-50-no-token","verb":"listSlots"}}' + "`n"))
Say 'pipe with a wrong token' (Send-Line ('{"v":1,"token":"' + ('0' * 64) + '","request":{"id":"audit-50-bad-token","verb":"listSlots"}}' + "`n"))
Say 'pipe with a line past 64 KiB' (Send-Line (('x' * (70 * 1024)) + "`n"))
Say 'pipe with a line that is not JSON' (Send-Line ("{not json`n"))

# ---- the folders --------------------------------------------------------------------------------------------------------
foreach ($rel in @('broker', 'broker\client.token', 'staging', 'logs', 'secrets', 'sqldata', 'golden', 'slots')) {
    $p = Join-Path $Root $rel
    try { Say "acl $rel" (Get-Acl -LiteralPath $p).Sddl } catch { Say "acl $rel" "unreadable by this user ($($_.Exception.GetType().Name))" }
}
foreach ($rel in @('logs', 'secrets')) {
    $p = Join-Path $Root $rel
    try { $n = @(Get-ChildItem -LiteralPath $p -Force).Count; Say "list $rel" "readable by this user ($n entries)" } catch { Say "list $rel" 'denied to this user' }
}

# ---- the broker's process and what it listens on -----------------------------------------------------------------------
$svc = Get-CimInstance -ClassName Win32_Service -Filter "Name = 'ArasHouseBroker'"
if ($null -eq $svc) {
    Say 'broker service' 'not installed'
} else {
    Say 'broker service' ("{0}, account {1}, pid {2}" -f $svc.State, $svc.StartName, $svc.ProcessId)
    $all = @(Get-CimInstance -ClassName Win32_Process)
    $tree = @([int]$svc.ProcessId)
    do {
        $more = @($all | Where-Object { $tree -contains [int]$_.ParentProcessId -and $tree -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
        $tree += $more
    } while ($more.Count -gt 0)
    Say 'broker process tree' (($all | Where-Object { $tree -contains [int]$_.ProcessId } | ForEach-Object { "$($_.Name)[$($_.ProcessId)] cmdline-visible=$([bool]$_.CommandLine)" }) -join ', ')
    $tcp = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $tree -contains [int]$_.OwningProcess })
    $udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $tree -contains [int]$_.OwningProcess })
    Say 'broker listeners' ("{0} TCP, {1} UDP{2}" -f $tcp.Count, $udp.Count, (($tcp + $udp | ForEach-Object { " $($_.LocalAddress):$($_.LocalPort)" }) -join ''))
}

# ---- port 80: who listens, on which addresses, and what the firewall lets in ----------------------------------------
Say 'port 80 listeners' ((Get-NetTCPConnection -State Listen -LocalPort 80 -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalAddress) (pid $($_.OwningProcess))" }) -join ', ')
$ipv4 = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' })
Say 'ipv4 addresses' (($ipv4 | ForEach-Object { "$($_.InterfaceAlias)=$($_.IPAddress)/$($_.PrefixLength)" }) -join ', ')
foreach ($ip in $ipv4) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri "http://$($ip.IPAddress)/ah-23-01/Client/" -MaximumRedirection 0 -ErrorAction Stop
        Say "slot answers on $($ip.InterfaceAlias)" "HTTP $($r.StatusCode)"
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $_.Exception.Message }
        Say "slot answers on $($ip.InterfaceAlias)" "$code"
    }
}
foreach ($rule in @(Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'IIS-WebServerRole-HTTP*' -or $_.Name -like 'arashouse*' -or $_.DisplayName -like '*arashouse*' })) {
    $addr = ($rule | Get-NetFirewallAddressFilter).RemoteAddress -join ','
    $port = ($rule | Get-NetFirewallPortFilter).LocalPort -join ','
    Say "firewall $($rule.Name)" ("{0}, profile {1}, local port {2}, remote {3}" -f $rule.Action, $rule.Profile, $port, $addr)
}

# ---- what Windows would record of a script or an install ----------------------------------------------------------------
foreach ($key in @('Transcription', 'ScriptBlockLogging', 'ModuleLogging')) {
    $found = @()
    foreach ($hive in @('HKLM:', 'HKCU:')) {
        foreach ($base in @('Software\Policies\Microsoft\Windows\PowerShell', 'Software\Wow6432Node\Policies\Microsoft\Windows\PowerShell')) {
            $item = Get-ItemProperty -LiteralPath "$hive\$base\$key" -ErrorAction SilentlyContinue
            if ($item) { $found += "$hive\$base\$key " + (($item.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ';') }
        }
    }
    Say "powershell $key policy" $(if ($found.Count) { $found -join ' | ' } else { 'not set' })
}
$msi = Get-ItemProperty -LiteralPath 'HKLM:\Software\Policies\Microsoft\Windows\Installer' -ErrorAction SilentlyContinue
Say 'msi logging policy' $(if ($msi -and $msi.Logging) { $msi.Logging } else { 'not set' })
exit 0
