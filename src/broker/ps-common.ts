// PowerShell shared by the generated Windows scripts: the baseline build's `baseline-steps.ps1`
// (ticket 24) and the broker's `slot-steps.ps1` (ticket 25). Text only, pasted into each script; the
// scripts define `$Root`, `$DeniedRoots`, `$DeniedServicePrefixes`, `$OwnServices` and `Stop-Step` before it.

/** `Test-Under` and `Get-Print`: a path prefix test and the SHA-256 of a text. */
export const PS_PATHS_AND_PRINTS = `function Test-Under([string]$Path, [string]$Parent) {
    $p = $Path.TrimEnd('\\') + '\\'
    $q = $Parent.TrimEnd('\\') + '\\'
    return $p.StartsWith($q, [StringComparison]::OrdinalIgnoreCase)
}
function Get-Print([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}`;

/** `New-Sql`, `Invoke-Sql`, `Format-Ident` and `Format-Str`: SQL Server on shared memory, Windows authentication, no pooled session left behind. */
export function psSql(applicationName: string): string {
  if (!/^[a-z-]+$/.test(applicationName)) throw new Error("an application name is lower-case letters and '-'");
  return `function Format-Ident([string]$Name) { return '[' + $Name.Replace(']', ']]') + ']' }
function Format-Str([string]$Text) { return "N'" + $Text.Replace("'", "''") + "'" }
function New-Sql {
    Add-Type -AssemblyName System.Data
    $c = New-Object System.Data.SqlClient.SqlConnection 'Data Source=lpc:.;Initial Catalog=master;Integrated Security=SSPI;Connect Timeout=15;Pooling=False;Application Name=${applicationName}'
    $c.Open()
    return $c
}
function Invoke-Sql($Connection, [string]$Query, [hashtable]$Parameters = @{}, [int]$TimeoutSeconds = 900) {
    $cmd = $Connection.CreateCommand()
    $cmd.CommandText = $Query
    $cmd.CommandTimeout = $TimeoutSeconds
    foreach ($k in $Parameters.Keys) { [void]$cmd.Parameters.AddWithValue($k, $Parameters[$k]) }
    $reader = $cmd.ExecuteReader()
    $rows = New-Object System.Collections.ArrayList
    try {
        do {
            while ($reader.Read()) {
                $row = [ordered]@{}
                for ($i = 0; $i -lt $reader.FieldCount; $i++) { $v = $reader.GetValue($i); $row[$reader.GetName($i)] = if ($v -is [DBNull]) { $null } else { $v } }
                [void]$rows.Add([pscustomobject]$row)
            }
        } while ($reader.NextResult())
    } finally { $reader.Dispose(); $cmd.Dispose() }
    return @($rows)
}`;
}

/** `Get-Iis`: a `ServerManager`, refused when the configuration reads as empty (not elevated). */
export const PS_IIS = `function Get-Iis {
    $dll = Join-Path $env:windir 'System32\\inetsrv\\Microsoft.Web.Administration.dll'
    if (-not (Test-Path -LiteralPath $dll)) { Stop-Step 'IIS is not installed (no Microsoft.Web.Administration.dll)' }
    Add-Type -Path $dll
    $mgr = New-Object Microsoft.Web.Administration.ServerManager
    # Without elevation the configuration reads as empty rather than failing; an empty read would make the checks pass on nothing.
    $readable = $false
    try { $readable = ($null -ne $mgr.Sites) -and (@($mgr.ApplicationPools).Count -gt 0) } catch { }
    if (-not $readable) { $mgr.Dispose(); Stop-Step 'the IIS configuration is not readable (run elevated)' }
    return $mgr
}`;

/**
 * `Get-DenyListPrints`: fingerprints of what is not arashouse's and that a change on the host could disturb: the
 * captain's install roots (their config's SHA-256), every IIS application and pool not named `ah-*` (settings and
 * members), the agent services of the deny-list, and the Aras products registered outside the root. Names and
 * hashes only; databases are not listed (the tool creates and drops only its own). `$OwnServices` names the deny-listed
 * services arashouse itself makes and removes, left out: the builds' `ArasInnovatorAgent_ah-build-<key>` (ticket 33b),
 * the build's own in `baseline-steps.ps1`, all three in `slot-steps.ps1` (a provision may overlap a build). Needs `PS_PATHS_AND_PRINTS` and `PS_IIS`.
 */
export const PS_DENY_LIST_PRINTS = `function Get-DenyListPrints {
    $prints = [ordered]@{}
    foreach ($r in $DeniedRoots) {
        $cfg = Join-Path $r 'InnovatorServerConfig.xml'
        $prints["install root $r"] = if (Test-Path -LiteralPath $cfg) { (Get-FileHash -LiteralPath $cfg -Algorithm SHA256).Hash.ToLowerInvariant() } elseif (Test-Path -LiteralPath $r) { 'no config' } else { 'absent' }
    }
    $mgr = Get-Iis
    try {
        $apps = @()
        foreach ($s in $mgr.Sites) {
            foreach ($app in $s.Applications) {
                $first = $app.Path.TrimStart('/').Split('/')[0]
                if ($first -like 'ah-*') { continue }
                $apps += $app
                $prints["IIS application $($s.Name)$($app.Path)"] = Get-Print ($app.ApplicationPoolName + '|' + $app.VirtualDirectories['/'].PhysicalPath)
            }
        }
        foreach ($pool in $mgr.ApplicationPools) {
            if ($pool.Name -like 'ah-*') { continue }
            $members = @($apps | Where-Object { $_.ApplicationPoolName -eq $pool.Name } | ForEach-Object { $_.Path } | Sort-Object) -join ','
            $prints["IIS pool $($pool.Name)"] = Get-Print (@($pool.ManagedRuntimeVersion, $pool.ManagedPipelineMode, $pool.Enable32BitAppOnWin64, $pool.ProcessModel.IdentityType, $pool.ProcessModel.UserName, $pool.ProcessModel.IdleTimeout, $pool.StartMode, $members) -join '|')
        }
    } finally { $mgr.Dispose() }
    foreach ($svc in @(Get-CimInstance Win32_Service)) {
        if (@($DeniedServicePrefixes | Where-Object { $svc.Name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) { continue }
        if (@($OwnServices) -contains $svc.Name) { continue }
        $prints["service $($svc.Name)"] = Get-Print (@($svc.PathName, $svc.StartMode, $svc.StartName) -join '|')
    }
    foreach ($hive in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
        foreach ($k in @(Get-ChildItem $hive -ErrorAction SilentlyContinue)) {
            $e = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
            if (-not $e -or -not ($e.DisplayName -like 'Aras*')) { continue }
            if ($e.InstallLocation -and (Test-Under $e.InstallLocation $Root)) { continue }
            $prints["product $($k.PSChildName)"] = Get-Print (@($e.DisplayName, $e.DisplayVersion, $e.InstallLocation) -join '|')
        }
    }
    return $prints
}`;
