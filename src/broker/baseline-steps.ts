// `baseline-steps.ps1`: the Windows operations of the baseline build (ticket 24) that Node cannot do
// itself: the MSI through the Windows Installer COM API, IIS through Microsoft.Web.Administration,
// SQL Server on shared memory, robocopy, icacls. build-system.ts runs one step per process:
//
//   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File baseline-steps.ps1 -Step <step>
//
// with a JSON request on stdin (`{ "flavor": "12sp9", ... }`; the build's SQL login passwords travel
// only there, only to the `database` step) and one `@@arashouse@@ <json>` line on stdout. The script
// takes no name or path from the request: it derives every one from the flavor, with the same rules
// as src/core/names.ts, and refuses a flavor that is not registered. Generated from the registry and
// the deny-list; the shapes come from the spike scripts (spike/10-baseline-install.ps1, 09, 20, 90).

import { BUILD_SCRATCH_SUFFIXES, DEFAULT_INSTALL_ROOT, buildNames } from "../core/names.js";
import { FLAVORS, FLAVOR_KEYS } from "../core/flavors.js";
import { DENIED_ALIASES, DENIED_INSTALL_ROOTS, DENIED_SERVICE_PREFIXES, assertValidRoot } from "../core/guards.js";
import { MSI_HIDDEN_PROPERTIES, SHIPPED_DATABASE_USERS } from "../core/baseline.js";
import { BROKER_SERVICE_NAME } from "../core/names.js";
import { psQuote, serviceSid } from "../core/setup-host.js";

/** The steps the script answers. */
export const PS_STEPS = [
  "survey",
  "snapshot",
  "msi-copy",
  "msi-cost",
  "install",
  "pools",
  "database",
  "stop",
  "server-version",
  "copy-tree",
  "backup",
  "remove",
  "seal",
] as const;
export type PsStep = (typeof PS_STEPS)[number];

/** The stdout line that carries a step's answer; anything else on stdout is the step's own chatter. */
export const RESULT_MARKER = "@@arashouse@@ ";

export const STEPS_SCRIPT_NAME = "baseline-steps.ps1";

export function renderBuildStepsScript(root: string = DEFAULT_INSTALL_ROOT): string {
  const r = assertValidRoot(root);
  for (const key of FLAVOR_KEYS) {
    if (buildNames(key, r).dir !== `${r}\\golden-build\\${key}`) throw new Error("the build folder rule changed; update baseline-steps.ts with names.ts");
  }
  const media = FLAVOR_KEYS.map(
    (key) =>
      `    ${psQuote(key)} = @{ msi = ${psQuote(FLAVORS[key].msiName)}; core = ${psQuote(FLAVORS[key].backups.core)}; cas = ${psQuote(FLAVORS[key].backups.coreAndSolutions)} }`,
  ).join("\n");
  const list = (items: readonly string[]) => `@(${items.map(psQuote).join(", ")})`;

  return `# baseline-steps.ps1: the Windows operations of \`arashouse baseline build\` (ticket 24, docs/baselines.md). Generated; do not edit.
# Started by the build (Node, elevated) once per step: -Step <name>, a JSON request on stdin, one result line on stdout.
# It derives every name and path from the flavor; nothing in the request names a path. Windows PowerShell 5.1.
param([Parameter(Mandatory = $true)][string]$Step)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = ${psQuote(r)}
$FlavorKeys = ${list(FLAVOR_KEYS)}
$MediaNames = @{
${media}
}
$ScratchSuffixes = ${list(BUILD_SCRATCH_SUFFIXES)}
$DeniedRoots = ${list(DENIED_INSTALL_ROOTS)}
$DeniedAliases = ${list(DENIED_ALIASES)}
$DeniedServicePrefixes = ${list(DENIED_SERVICE_PREFIXES)}
$HiddenProperties = ${list(MSI_HIDDEN_PROPERTIES)}
$ShippedUsers = [ordered]@{ dbo = ${psQuote(SHIPPED_DATABASE_USERS.dbo)}; reg = ${psQuote(SHIPPED_DATABASE_USERS.reg)} }
$BrokerSid = ${psQuote(serviceSid(BROKER_SERVICE_NAME))}
$Site = 'Default Web Site'

function Stop-Step([string]$Message) { [Console]::Error.WriteLine("error: $Message"); exit 1 }
function Write-Result($Value) { [Console]::Out.WriteLine(${psQuote("@@arashouse@@ ")} + (ConvertTo-Json -InputObject $Value -Depth 8 -Compress)) }

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$Flavor = [string]$request.flavor
if ($FlavorKeys -cnotcontains $Flavor) { Stop-Step 'the request names no registered flavor' }
if (${list(PS_STEPS)} -cnotcontains $Step) { Stop-Step "no step '$Step'" }

# The names, as src/core/names.ts derives them.
$Alias = "ah-build-$Flavor"
$Database = "arashouse_build_$Flavor"
$LoginDbo = "$($Database)_dbo"
$LoginReg = "$($Database)_reg"
$PoolPrefix = "$Alias-"
$BuildDir = Join-Path $Root "golden-build\\$Flavor"
$MsiDir = "$BuildDir.msi"
$VaultRoot = "$BuildDir.vault"
$Candidate = "$BuildDir.golden"
$Retired = "$BuildDir.old"
$Golden = Join-Path $Root "golden\\$Flavor"
$MediaDir = Join-Path $Root "staging\\baseline-$Flavor\\media"
$SqlData = Join-Path $Root 'sqldata'
$DataFile = Join-Path $SqlData "$Database.mdf"
$LogFile = Join-Path $SqlData "$($Database)_log.ldf"
$BackupScratch = Join-Path $SqlData "$Database-ootb.bak"

function Test-Under([string]$Path, [string]$Parent) {
    $p = $Path.TrimEnd('\\') + '\\'
    $q = $Parent.TrimEnd('\\') + '\\'
    return $p.StartsWith($q, [StringComparison]::OrdinalIgnoreCase)
}
function Get-Print([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

# ---- SQL Server: shared memory, Windows authentication (the elevated user's own login), no pooled session left behind ----
function Format-Ident([string]$Name) { return '[' + $Name.Replace(']', ']]') + ']' }
function Format-Str([string]$Text) { return "N'" + $Text.Replace("'", "''") + "'" }
function New-Sql {
    Add-Type -AssemblyName System.Data
    $c = New-Object System.Data.SqlClient.SqlConnection 'Data Source=lpc:.;Initial Catalog=master;Integrated Security=SSPI;Connect Timeout=15;Pooling=False;Application Name=arashouse-baseline'
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
}

# ---- IIS ----
function Get-Iis {
    $dll = Join-Path $env:windir 'System32\\inetsrv\\Microsoft.Web.Administration.dll'
    if (-not (Test-Path -LiteralPath $dll)) { Stop-Step 'IIS is not installed (no Microsoft.Web.Administration.dll)' }
    Add-Type -Path $dll
    $mgr = New-Object Microsoft.Web.Administration.ServerManager
    # Without elevation the configuration reads as empty rather than failing; an empty read would make the checks pass on nothing.
    $readable = $false
    try { $readable = ($null -ne $mgr.Sites) -and (@($mgr.ApplicationPools).Count -gt 0) } catch { }
    if (-not $readable) { $mgr.Dispose(); Stop-Step 'the IIS configuration is not readable (run elevated)' }
    return $mgr
}
function Test-BuildApp([string]$Path) { return ($Path -ieq "/$Alias") -or $Path.StartsWith("/$Alias/", [StringComparison]::OrdinalIgnoreCase) }
function Get-Role([string]$SubPath) {
    $role = $SubPath.Trim('/').ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    if (-not $role) { return 'root' }
    return $role
}

# ---- Windows Installer ----
function Get-MsiValue($Db, [string]$Name) {
    $view = $Db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $Db, @("SELECT \`\`Value\`\` FROM \`\`Property\`\` WHERE \`\`Property\`\` = '$Name'"))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
    $value = if ($rec) { [string]$rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, [object[]]@([int]1)) } else { $null }
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    return $value
}
function Invoke-MsiSql($Db, [string]$Sql) {
    $view = $Db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $Db, @($Sql))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
}
function Get-InstalledProducts {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    return @($installer.GetType().InvokeMember('Products', 'GetProperty', $null, $installer, $null) | ForEach-Object { [string]$_ })
}
function Get-BuildProducts {
    # Products whose InstallLocation is the build's install directory: the throw-away instance's own registration.
    $found = @()
    foreach ($hive in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
        foreach ($k in @(Get-ChildItem $hive -ErrorAction SilentlyContinue)) {
            if ($k.PSChildName -notmatch '^\\{[0-9A-Fa-f-]{36}\\}$') { continue }
            $loc = (Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue).InstallLocation
            if ($loc -and (Test-Under $loc $BuildDir)) { $found += $k.PSChildName }
        }
    }
    return @($found | Select-Object -Unique)
}

# ---- what of the throw-away instance exists (names only) ----
function Get-Present([switch]$NoFolders) {
    $present = @()
    if (-not $NoFolders) {
        foreach ($d in @($BuildDir) + @($ScratchSuffixes | ForEach-Object { "$BuildDir.$_" })) { if (Test-Path -LiteralPath $d) { $present += $d } }
    }
    $mgr = Get-Iis
    try {
        $s = $mgr.Sites[$Site]
        if ($s) { foreach ($app in $s.Applications) { if (Test-BuildApp $app.Path) { $present += "IIS application $($app.Path)" } } }
        foreach ($pool in $mgr.ApplicationPools) { if ($pool.Name.StartsWith($PoolPrefix, [StringComparison]::OrdinalIgnoreCase)) { $present += "IIS pool $($pool.Name)" } }
    } finally { $mgr.Dispose() }
    $c = New-Sql
    try {
        foreach ($row in (Invoke-Sql $c 'SELECT name FROM sys.databases WHERE name = @n' @{ '@n' = $Database })) { $present += "database $($row.name)" }
        foreach ($row in (Invoke-Sql $c 'SELECT name FROM sys.server_principals WHERE name IN (@a, @b)' @{ '@a' = $LoginDbo; '@b' = $LoginReg })) { $present += "login $($row.name)" }
        foreach ($row in (Invoke-Sql $c 'SELECT name FROM master.sys.database_principals WHERE name IN (@a, @b)' @{ '@a' = $LoginDbo; '@b' = $LoginReg })) { $present += "master user $($row.name)" }
    } finally { $c.Dispose() }
    foreach ($p in (Get-BuildProducts)) { $present += "product $p" }
    foreach ($svc in @(Get-CimInstance Win32_Service)) {
        $image = if ($svc.PathName) { $svc.PathName.Trim().Trim('"') } else { '' }
        if ($image -and (Test-Under $image $BuildDir)) { $present += "service $($svc.Name)" }
    }
    if (Test-Path -LiteralPath $BackupScratch) { $present += $BackupScratch }
    return @($present)
}

switch ($Step) {
    'survey' {
        Write-Result @{ present = @(Get-Present) }
    }
    'snapshot' {
        # Fingerprints of what is not arashouse's and that a build could disturb: the captain's install roots (their config's SHA-256),
        # every IIS application and pool not named ah-* (settings and members), the agent services of the deny-list, and the Aras
        # products registered outside the root. Names and hashes only; databases are not listed (the build creates and drops only its own).
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
        Write-Result @{ prints = $prints }
    }
    'msi-copy' {
        # A copy of the MSI with a new ProductCode, ProductID, UpgradeCode and package code (what Aras's ChangeGUID does to the MSI, without
        # its registry writes): the shipped MSI shares the ProductCode of the captain's installs and would run in maintenance mode on them.
        $source = Join-Path $MediaDir $MediaNames[$Flavor].msi
        if (-not (Test-Path -LiteralPath $source)) { Stop-Step "the bundle has no $source" }
        if (-not (Test-Path -LiteralPath $MsiDir)) { New-Item -ItemType Directory -Path $MsiDir | Out-Null }
        $target = Join-Path $MsiDir 'InnovatorSetup.msi'
        Copy-Item -LiteralPath $source -Destination $target -Force
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @([string]$target, [int]1))
        # The summary information first: a view opened on the database before it makes the property set fail.
        $summary = $db.GetType().InvokeMember('SummaryInformation', 'GetProperty', $null, $db, [object[]]@([int]1))
        $summary.GetType().InvokeMember('Property', 'SetProperty', $null, $summary, [object[]]@([int]9, ('{' + [guid]::NewGuid().ToString().ToUpperInvariant() + '}')))
        $summary.GetType().InvokeMember('Persist', 'InvokeMethod', $null, $summary, $null) | Out-Null
        $code = '{' + [guid]::NewGuid().ToString().ToUpperInvariant() + '}'
        foreach ($name in @('ProductCode', 'ProductID')) { Invoke-MsiSql $db "UPDATE \`\`Property\`\` SET \`\`Value\`\` = '$code' WHERE \`\`Property\`\` = '$name'" }
        Invoke-MsiSql $db ("UPDATE \`\`Property\`\` SET \`\`Value\`\` = '{" + [guid]::NewGuid().ToString().ToUpperInvariant() + "}' WHERE \`\`Property\`\` = 'UpgradeCode'")
        $db.GetType().InvokeMember('Commit', 'InvokeMethod', $null, $db, $null) | Out-Null
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($summary)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db)
        $db = $null; $summary = $null
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        $check = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @([string]$target, [int]0))
        $copyCode = Get-MsiValue $check 'ProductCode'
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($check)
        if ($copyCode -ne $code -or (Get-InstalledProducts) -contains $copyCode) { Stop-Step 'the copy still carries an installed ProductCode; nothing was installed' }
        Write-Result @{ msi = $target; productCode = $copyCode }
    }
    'msi-cost' {
        # Costs the copy without installing it (CostInitialize, FileCost, CostFinalize) and lists every folder a component writes to that
        # does not resolve under the build's install directory or vault root. Omitting INSTALLDIR and VAULT_ROOT once installed into the
        # captain's Release 23 root (spike 05).
        $msi = Join-Path $MsiDir 'InnovatorSetup.msi'
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $installer.GetType().InvokeMember('UILevel', 'SetProperty', $null, $installer, [object[]]@([int]2)) | Out-Null
        $session = $installer.GetType().InvokeMember('OpenPackage', 'InvokeMethod', $null, $installer, @([string]$msi, [int]0))
        foreach ($kv in @(@('INSTALLDIR', $BuildDir), @('VAULT_ROOT', $VaultRoot))) { $session.GetType().InvokeMember('Property', 'SetProperty', $null, $session, [object[]]@([string]$kv[0], [string]$kv[1])) | Out-Null }
        foreach ($a in @('CostInitialize', 'FileCost', 'CostFinalize')) { $session.GetType().InvokeMember('DoAction', 'InvokeMethod', $null, $session, @([string]$a)) | Out-Null }
        $db = $session.GetType().InvokeMember('Database', 'GetProperty', $null, $session, $null)
        $outside = @()
        $seen = @{}
        foreach ($sql in @('SELECT \`Directory_\` FROM \`Component\`', 'SELECT \`Directory_\` FROM \`CreateFolder\`')) {
            $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($sql))
            $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
            while ($true) {
                $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
                if (-not $rec) { break }
                $key = [string]$rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, [object[]]@([int]1))
                if ($seen.ContainsKey($key)) { continue }
                $seen[$key] = $true
                $path = $null
                try { $path = [string]$session.GetType().InvokeMember('TargetPath', 'GetProperty', $null, $session, [object[]]@($key)) } catch { }
                if (-not $path) { continue }
                if (-not ((Test-Under $path $BuildDir) -or (Test-Under $path $VaultRoot))) { $outside += "$key=$path" }
            }
            $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
        }
        $install = [string]$session.GetType().InvokeMember('TargetPath', 'GetProperty', $null, $session, [object[]]@('INSTALLDIR'))
        $vault = [string]$session.GetType().InvokeMember('TargetPath', 'GetProperty', $null, $session, [object[]]@('VAULT_ROOT'))
        if (-not (Test-Under $install $BuildDir)) { $outside += "INSTALLDIR=$install" }
        if (-not (Test-Under $vault $VaultRoot)) { $outside += "VAULT_ROOT=$vault" }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($session)
        Write-Result @{ outside = @($outside); folders = $seen.Count }
    }
    'install' {
        # In-process through the COM API (UI level none). The properties are the request's, each checked against the MSI's Property table
        # unless Windows Installer itself defines it; none is secret. The log (no property dump) is read for failed actions and deleted.
        $msi = Join-Path $MsiDir 'InnovatorSetup.msi'
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @([string]$msi, [int]0))
        $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @('SELECT \`Property\` FROM \`Property\`'))
        $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
        $names = @{}
        while ($true) { $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null); if (-not $rec) { break }; $names[[string]$rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @(1))] = $true }
        $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db)
        $builtIn = @('INSTALLDIR', 'VAULT_ROOT', 'REBOOT', 'MSIRESTARTMANAGERCONTROL')
        $want = [ordered]@{
            INSTALLDIR = $BuildDir; VAULT_ROOT = $VaultRoot; WEBALIAS = $Alias; INSTALL_DATABASE = '0'; INSTALL_AGENT_SERVICE = '0'
            IS_SQLSERVER_SERVER = '(local)'; IS_SQLSERVER_DATABASE = $Database; IS_SQLSERVER_AUTHENTICATION = '0'
            SQL_SERVER_LOGIN_NAME = $LoginDbo; SQL_SERVER_LOGIN_REGULAR_NAME = $LoginReg; REBOOT = 'ReallySuppress'; MSIRESTARTMANAGERCONTROL = 'Disable'
        }
        $missing = @($want.Keys | Where-Object { $builtIn -notcontains $_ -and -not $names.ContainsKey($_) })
        if ($missing.Count -gt 0) { Stop-Step "the MSI has no property $($missing -join ', '); nothing was installed" }
        $cmd = (@($want.Keys | ForEach-Object { '{0}="{1}"' -f $_, $want[$_] }) + @('MsiHiddenProperties="' + ($HiddenProperties -join ';') + '"')) -join ' '
        $log = Join-Path $MsiDir 'install.log'
        $installer.UILevel = 2
        $installer.EnableLog('iwearucmo', $log)
        $exit = 0
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try { $installer.InstallProduct($msi, $cmd) } catch [Runtime.InteropServices.COMException] { $exit = $_.Exception.ErrorCode -band 0xFFFF }
        $failed = @()
        $errors = @()
        if (Test-Path -LiteralPath $log) {
            $text = [IO.File]::ReadAllText($log)
            $failed = @([regex]::Matches($text, 'Action ended [\\d:]+: (\\w+)\\. Return value 3') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
            $errors = @([regex]::Matches($text, 'Error (\\d{4})\\.') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
            Remove-Item -LiteralPath $log -Force
        }
        Write-Result @{ exitCode = $exit; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); failedActions = @($failed); errors = @($errors) }
    }
    'pools' {
        # The MSI puts its applications in machine-wide pools the captain's installs share; each gets its own pool <alias>-<role> with the same settings.
        $mgr = Get-Iis
        $apps = @()
        try {
            $s = $mgr.Sites[$Site]
            if (-not $s) { Stop-Step "IIS has no site '$Site'" }
            foreach ($app in @($s.Applications | Where-Object { Test-BuildApp $_.Path })) {
                $sub = $app.Path.Substring($Alias.Length + 1)
                $poolName = $PoolPrefix + (Get-Role $sub)
                $from = $mgr.ApplicationPools[$app.ApplicationPoolName]
                $pool = $mgr.ApplicationPools[$poolName]
                if (-not $pool) {
                    $pool = $mgr.ApplicationPools.Add($poolName)
                    if ($from) {
                        $pool.ManagedRuntimeVersion = $from.ManagedRuntimeVersion
                        $pool.ManagedPipelineMode = $from.ManagedPipelineMode
                        $pool.Enable32BitAppOnWin64 = $from.Enable32BitAppOnWin64
                        $pool.ProcessModel.IdentityType = $from.ProcessModel.IdentityType
                        $pool.ProcessModel.IdleTimeout = $from.ProcessModel.IdleTimeout
                        $pool.StartMode = $from.StartMode
                    }
                }
                $app.ApplicationPoolName = $poolName
                $physical = $app.VirtualDirectories['/'].PhysicalPath
                if (-not (Test-Under $physical $BuildDir)) { Stop-Step "the application $($app.Path) points outside $BuildDir" }
                $apps += [ordered]@{
                    subPath = $sub
                    physicalPath = $physical.Substring($BuildDir.Length).Trim('\\')
                    role = (Get-Role $sub)
                    pool = [ordered]@{
                        managedRuntimeVersion = [string]$pool.ManagedRuntimeVersion
                        pipelineMode = $pool.ManagedPipelineMode.ToString()
                        enable32Bit = [bool]$pool.Enable32BitAppOnWin64
                        identityType = $pool.ProcessModel.IdentityType.ToString()
                        idleTimeout = $pool.ProcessModel.IdleTimeout.ToString()
                        startMode = $pool.StartMode.ToString()
                    }
                }
            }
            $mgr.CommitChanges()
        } finally { $mgr.Dispose() }
        # golden-build\\ has a protected ACL (SYSTEM, Administrators, the broker), and the MSI's own grants assume a folder that inherits
        # broad rights: it turns inheritance off on OAuthServer\\App_Data and gives IIS_IUSRS modify on that folder only, not on the SQLite
        # file in it (one build's OAuth server died with "unable to open database file"; the first answered HTTP 500 everywhere). So
        # IIS_IUSRS, which every pool identity belongs to, gets modify on every folder and file of the instance and its vault, and
        # anonymous requests (IUSR) read. The grants stay on the throw-away instance: robocopy copies no ACL into golden.
        foreach ($dir in @($BuildDir, $VaultRoot)) {
            if (-not (Test-Path -LiteralPath $dir)) { continue }
            & icacls.exe $dir /grant '*S-1-5-32-568:(OI)(CI)M' /T /C /Q | Out-Null
            if ($LASTEXITCODE -ne 0) { Stop-Step "icacls could not grant IIS_IUSRS on $dir ($LASTEXITCODE)" }
        }
        & icacls.exe $BuildDir /grant '*S-1-5-17:(OI)(CI)RX' /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-Step "icacls could not grant IUSR read on $BuildDir ($LASTEXITCODE)" }
        Write-Result @{ applications = @($apps | Sort-Object { $_.subPath }) }
    }
    'database' {
        # The build's two logins (generated passwords, from the request only), the shipped CoreAndSolutions backup restored under sqldata\\,
        # and its users innovator and innovator_regular mapped to them (spike record, section 4). The CD's SQL scripts are not run: they
        # name the machine-wide logins the captain's databases use.
        $bak = Join-Path $MediaDir $MediaNames[$Flavor].cas
        if (-not (Test-Path -LiteralPath $bak)) { Stop-Step "the bundle has no $bak" }
        $dbo = [string]$request.secrets.dbo
        $reg = [string]$request.secrets.reg
        if ($dbo.Length -lt 16 -or $reg.Length -lt 16) { Stop-Step 'the request carries no login passwords' }
        $c = New-Sql
        try {
            foreach ($pair in @(@($LoginDbo, $dbo), @($LoginReg, $reg))) {
                Invoke-Sql $c ("CREATE LOGIN " + (Format-Ident $pair[0]) + " WITH PASSWORD = " + (Format-Str $pair[1]) + ", CHECK_POLICY = OFF, CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = master") | Out-Null
            }
            $dbo = $null; $reg = $null; $request = $null
            $files = Invoke-Sql $c ("RESTORE FILELISTONLY FROM DISK = " + (Format-Str $bak))
            $data = @($files | Where-Object { $_.Type -eq 'D' })
            $logs = @($files | Where-Object { $_.Type -eq 'L' })
            if ($data.Count -ne 1 -or $logs.Count -ne 1) { Stop-Step "the backup has $($data.Count) data and $($logs.Count) log files, not one of each" }
            $move = "MOVE " + (Format-Str $data[0].LogicalName) + " TO " + (Format-Str $DataFile) + ", MOVE " + (Format-Str $logs[0].LogicalName) + " TO " + (Format-Str $LogFile)
            Invoke-Sql $c ("RESTORE DATABASE " + (Format-Ident $Database) + " FROM DISK = " + (Format-Str $bak) + " WITH " + $move + ", RECOVERY") | Out-Null
            $db = Format-Ident $Database
            $users = @(Invoke-Sql $c ("SELECT name FROM $db.sys.database_principals WHERE type = 'S'") | ForEach-Object { $_.name })
            foreach ($role in @('dbo', 'reg')) {
                $user = $ShippedUsers[$role]
                if ($users -notcontains $user) { Stop-Step "the restored database has no user $user" }
                $login = if ($role -eq 'dbo') { $LoginDbo } else { $LoginReg }
                Invoke-Sql $c ("USE $db; ALTER USER " + (Format-Ident $user) + " WITH LOGIN = " + (Format-Ident $login)) | Out-Null
            }
        } finally { $c.Dispose() }
        Write-Result @{ database = $Database }
    }
    'stop' {
        $mgr = Get-Iis
        try {
            foreach ($pool in $mgr.ApplicationPools) {
                if (-not $pool.Name.StartsWith($PoolPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
                if ($pool.State -eq [Microsoft.Web.Administration.ObjectState]::Started) { [void]$pool.Stop() }
                for ($i = 0; $i -lt 120 -and $pool.State -ne [Microsoft.Web.Administration.ObjectState]::Stopped; $i++) { Start-Sleep -Milliseconds 500 }
            }
        } finally { $mgr.Dispose() }
        # Stopping a pool returns before its worker process has gone; wait for the build's w3wp.exe to exit, so no file stays locked.
        for ($i = 0; $i -lt 120; $i++) {
            $left = @(Get-CimInstance Win32_Process -Filter "Name='w3wp.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains('"' + $PoolPrefix.ToLowerInvariant()) })
            if ($left.Count -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
        Write-Result @{ stopped = $true }
    }
    'server-version' {
        $dll = Join-Path $BuildDir 'Innovator\\Server\\bin\\Aras.Server.Core.dll'
        $version = if (Test-Path -LiteralPath $dll) { (Get-Item -LiteralPath $dll).VersionInfo.FileVersion } else { $null }
        Write-Result @{ version = $version }
    }
    'copy-tree' {
        # robocopy keeps the files' times, which the manifest records; junctions are not followed; the install's DB folder is left out.
        $to = Join-Path $Candidate 'tree'
        if (-not (Test-Path -LiteralPath $BuildDir)) { Stop-Step "$BuildDir does not exist" }
        & robocopy.exe $BuildDir $to /E /XJ /COPY:DAT /DCOPY:T /R:2 /W:1 /MT:16 /XD (Join-Path $BuildDir 'DB') /NFL /NDL /NJH /NJS /NP | Out-Null
        $rc = $LASTEXITCODE
        if ($rc -ge 8) { Stop-Step "robocopy failed ($rc)" }
        $files = 0; $bytes = 0L
        foreach ($f in (Get-ChildItem -LiteralPath $to -Recurse -File -Force)) { $files++; $bytes += $f.Length }
        Write-Result @{ files = $files; bytes = $bytes }
    }
    'backup' {
        # SQL Server may write sqldata\\, not golden\\: the backup lands there and the build copies it into the new golden.
        if (Test-Path -LiteralPath $BackupScratch) { Remove-Item -LiteralPath $BackupScratch -Force }
        $c = New-Sql
        try { Invoke-Sql $c ("BACKUP DATABASE " + (Format-Ident $Database) + " TO DISK = " + (Format-Str $BackupScratch) + " WITH COPY_ONLY, INIT, FORMAT, CHECKSUM") | Out-Null } finally { $c.Dispose() }
        Write-Result @{ file = $BackupScratch }
    }
    'remove' {
        # Everything the throw-away instance has outside its folders (the build removes those): its IIS applications and pools, the product
        # registration (msiexec /x after the applications are gone, as spike 90 did), the database, its logins and their master users,
        # any service whose binary is in the build folder, ASP.NET's temporary files of the alias, the backup scratch file.
        $mgr = Get-Iis
        try {
            $s = $mgr.Sites[$Site]
            if ($s) { foreach ($app in @($s.Applications | Where-Object { Test-BuildApp $_.Path })) { $s.Applications.Remove($app) } }
            foreach ($pool in @($mgr.ApplicationPools | Where-Object { $_.Name.StartsWith($PoolPrefix, [StringComparison]::OrdinalIgnoreCase) })) { $mgr.ApplicationPools.Remove($pool) }
            $mgr.CommitChanges()
        } finally { $mgr.Dispose() }
        foreach ($code in (Get-BuildProducts)) {
            $p = Start-Process -FilePath msiexec.exe -ArgumentList @('/x', $code, '/qn', 'REMOVE_DATABASES=0', 'REBOOT=ReallySuppress', 'MSIRESTARTMANAGERCONTROL=Disable', '/norestart') -Wait -PassThru
            if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010 -and $p.ExitCode -ne 1605) { [Console]::Error.WriteLine("warning: msiexec /x $code returned $($p.ExitCode)") }
        }
        foreach ($svc in @(Get-CimInstance Win32_Service)) {
            $image = if ($svc.PathName) { $svc.PathName.Trim().Trim('"') } else { '' }
            if (-not $image -or -not (Test-Under $image $BuildDir)) { continue }
            if ($svc.State -ne 'Stopped') { Stop-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue }
            & sc.exe delete $svc.Name | Out-Null
        }
        $c = New-Sql
        try {
            if (@(Invoke-Sql $c 'SELECT name FROM sys.databases WHERE name = @n' @{ '@n' = $Database }).Count -gt 0) {
                $db = Format-Ident $Database
                Invoke-Sql $c "ALTER DATABASE $db SET SINGLE_USER WITH ROLLBACK IMMEDIATE" | Out-Null
                Invoke-Sql $c "DROP DATABASE $db" | Out-Null
            }
            foreach ($login in @($LoginDbo, $LoginReg)) {
                if (@(Invoke-Sql $c 'SELECT name FROM master.sys.database_principals WHERE name = @n' @{ '@n' = $login }).Count -gt 0) { Invoke-Sql $c ("USE master; DROP USER " + (Format-Ident $login)) | Out-Null }
                if (@(Invoke-Sql $c 'SELECT name FROM sys.server_principals WHERE name = @n' @{ '@n' = $login }).Count -gt 0) {
                    foreach ($row in (Invoke-Sql $c 'SELECT session_id FROM sys.dm_exec_sessions WHERE login_name = @n' @{ '@n' = $login })) { Invoke-Sql $c ("KILL " + [int]$row.session_id) | Out-Null }
                    Invoke-Sql $c ("DROP LOGIN " + (Format-Ident $login)) | Out-Null
                }
            }
        } finally { $c.Dispose() }
        foreach ($fw in @('Framework', 'Framework64')) {
            $base = Join-Path $env:windir "Microsoft.NET\\$fw\\v4.0.30319\\Temporary ASP.NET Files"
            if (-not (Test-Path -LiteralPath $base)) { continue }
            foreach ($d in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq $Alias -or $_.Name -like "$($Alias)_*" })) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        }
        if (Test-Path -LiteralPath $BackupScratch) { Remove-Item -LiteralPath $BackupScratch -Force }
        Write-Result @{ left = @(Get-Present -NoFolders) }
    }
    'seal' {
        # golden\\<key>: SYSTEM and Administrators full, the broker and SQL Server read, and the broker denied every change, since it is an
        # Administrator: only an elevated build changes golden. Children get the folder's ACL again (the tree was assembled under golden-build\\).
        if (-not (Test-Path -LiteralPath $Golden)) { Stop-Step "$Golden does not exist" }
        $sql = (Get-CimInstance Win32_Service -Filter "Name='MSSQLSERVER'").StartName
        if (-not $sql) { Stop-Step 'the MSSQLSERVER service was not found' }
        & icacls.exe $Golden /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$($BrokerSid):(OI)(CI)RX" "$($sql):(OI)(CI)RX" /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-Step "icacls /grant on $Golden failed ($LASTEXITCODE)" }
        & icacls.exe $Golden /inheritance:r /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-Step "icacls /inheritance:r on $Golden failed ($LASTEXITCODE)" }
        & icacls.exe $Golden /deny "*$($BrokerSid):(OI)(CI)(DE,DC,WD,AD,WEA,WA,WDAC,WO)" /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-Step "icacls /deny on $Golden failed ($LASTEXITCODE)" }
        & icacls.exe (Join-Path $Golden '*') /reset /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-Step "icacls /reset under $Golden failed ($LASTEXITCODE)" }
        Write-Result @{ sealed = $Golden }
    }
}
`;
}
